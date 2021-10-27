(function() {

    /**
     * The current plugin state
     */
    const state = {
        history: []
    }

    const constants = {
        apiTimeout: 25,

        // h - this scale seems to fit the map better but needs to check further
        convertMetersToFeet: 2.407454667562122//3.28084
    }

    /**
     *  Get the numeric value of an input element. Defaults to 1.
     * @param {string} id - The id of the input element
     * @returns {number}
     */
    const getInputNumberById = id => {
        const element = document.getElementById(id)
        const value = element !== null ? element.value : 0
        const number = Number(value)

        if(isNaN(number) || number === 0)
            throw `Failed to get input value of element #${id}`

        return number
    }

    /**
     *  Create 3D context
     */

    const create3DContext = async () => {
        try {
            // Undo the last history map
            undoLastHistory()

            // Create an object of all the HTML <input> values
            const inputs = {                
                latitude: getInputNumberById("Latitude"),
                longitude: getInputNumberById("Longitude"),
                radius: getInputNumberById("Radius")
            }

         

            // https://www.openstreetmap.org/#map=17/51.50111/-0.12531
            const locationGeoPoint = turf.point([ inputs.latitude, inputs.longitude ])
           

            const locationGeoBbox = getBbox(locationGeoPoint, inputs.radius)

            // Get the data from the OpenStreetMaps API
            const osmData = await getOSMData(locationGeoBbox)

            // Convert the OpenStreetMaps data to GeoJSON
            const geoJsonData = osmtogeojson(osmData)

            const geoFeatures = geoJsonData.features.filter(feature => feature.geometry.type === "Polygon")

            // const locationProjected = turf.toMercator(locationGeoPoint)

            // Determine the center point as locationProjected does not work
            const geoFeatureCollection = turf.featureCollection(geoFeatures)
            const centerGeoPoint = turf.center(geoFeatureCollection)
            const centerProjected = turf.toMercator(centerGeoPoint)

            // Convert the GeoJSON features from WGS84 format to mercator projection
            const featuresProjected = geoFeatures.map(x => turf.toMercator(x))

            // Create FormIt geometry
            createFormItGeometry(featuresProjected, centerProjected)

            
        }
        catch (e) {
            logMessage("An error has occured")
            logMessage(e)
            console.error("An error has occured", e)
        }
    }

    /**
     * Get the bounding box around the origin
     * @param {Object} locationGeoPoint - GeoJSON location point
     * @returns {Object} A turf.js bounding box
     */
    const getBbox = (locationGeoPoint, radius) => {
        const circle = turf.circle(locationGeoPoint, radius * 0.001, { steps: 4 })
        return turf.bbox(circle)
    }

    /**
     * Get the data from the OpenStreetMaps API
     * @param {Object} bbox - Bounding box
     * @returns {Object} The OSM response as an awaitable JSON object
     */
    const getOSMData = async (bbox) => {
        const filters = [ "building" ]
        const endpoint = "http://overpass-api.de/api/interpreter"
        const bounds = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`

        let query = `?data=[out:json][timeout:${constants.apiTimeout}][bbox:${bounds}];`
        if (filters.length > 0) {
            query += "("

            filters.forEach(filter => {
                query += `way[${filter}];`
                query += `relation[${filter}];`
            })

            query += ");"
        }
        query += "(._;>;);"
        query += "out;"

        const url = endpoint + query
        logMessage(`Sending API request`)
        logMessage(`This could take up to ${constants.apiTimeout} seconds`)
        const response = await fetch(url)
        if(response.ok)
            return response.json()
        throw `API request failed. ${response.status} ${response.statusText}`
    }

    /**
     * Create FormIt geometry
     * @param {Array} features - An array of GeoJSON features
     * @param {Object} center - GeoJSON location point
     * @returns {Array} FormIt extrusions
     */
    const createFormItGeometry = async (features, center) => {
        // Create a new history ID and store it in the plugin state object
        state.history.push(await FormIt.GroupEdit.GetEditingHistoryID())

        // Loop through each feature
        const geometryFormIt = Promise.all(features.map(async feature => {
            const storeyHeight = 4
            let height = storeyHeight

            if(!_.isUndefined(feature.properties.building))
                height = feature.properties.height

            if(!_.isUndefined(feature.properties["building:levels"]))
                height = feature.properties["building:levels"] * storeyHeight

            // h - better to let undetermined height obj remain flat or taking standard storeyheight?
            else 
                height = storeyHeight

            // Convert each GeoJSON polygon to an array of FormIt points
            const polygonsFormIt = feature.geometry.coordinates.map(async polygon => {
                return Promise.all(polygon.map(vertex => {
                    const x = vertex[0] - center.geometry.coordinates[0]
                    const y = vertex[1] - center.geometry.coordinates[1]
                    const xInternal = convertMetersToFormItUnits(x)
                    const yInternal = convertMetersToFormItUnits(y)
                    const zInternal = 0
                    return WSM.Geom.Point3d(xInternal, yInternal, zInternal)
                }))
            })

            return Promise.all(polygonsFormIt.map(async points => {
                try {
                    const historyID = _.last(state.history)

                    // Create polylines
                    WSM.APICreatePolyline(historyID, await points, false)

                    const heightInternal = convertMetersToFormItUnits(height)

                    // h - add functions to determine points clock/anticlock wise direction
                    //--

                    // h - group function
                    const groupID = await WSM.APICreateGroup(historyID,[])
                    //logMessage('1. create new group')
             
                    const groupHistoryID = await WSM.APIGetGroupReferencedHistoryReadOnly(historyID,groupID)
                    //logMessage('2. create new group history ID')

                    // create extrusion under the group history ID
                    WSM.APICreateExtrusion(groupHistoryID, await points, heightInternal)                 


                    // Create extrusions
                    //return  WSM.APICreateExtrusion(historyID, await points, heightInternal)  
                }
                catch (e) {
                    throw 'Failed to create extrusion'
                }
            }))
        }))

        logMessage(`Created ${(await geometryFormIt).length} features`)
    }

    /**
     * Convert a length in meters to the FormIt internal units
     * @param {Number} length Length in meters
     * @returns {Number} Length in feet
     */
    const convertMetersToFormItUnits = length =>
    {
        return length * constants.convertMetersToFeet
    }

    const mapGeoJsonPolygonCoordinates = (features, fn) => {
        return features.map(feature => {
            const featureMoved = _.clone(feature)
            const movedCoordinates = feature.geometry.coordinates.map(polygon => {
                return polygon.map(vertex => fn(vertex))
            })
            featureMoved.geometry.coordinates = movedCoordinates
            return featureMoved
        })
    }

    /**
     *  Undo the last history item
     */
    const undoLastHistory = () => {
        // If there is history
        if(state.history.length > 0) {
            // Get the last history ID from the plugin state object
            const lastHistoryID = _.last(state.history)

            // Delete all the geometry created in the last history operation
            WSM.APIDeleteHistory(lastHistoryID)

            // Remove the latest history ID from the plugin state object
            state.history.pop()
        }
    }


    /**
     *  h - Find coordinates from address set by users
     */
    const updateCoordinatesFromLocation = async()=>
    {    
        //Get location info set by user    
        const location = await FormIt.SunAndLocation.GetLocationDateTime()
        const lat = location.latitude
        const long = location.longitude

        //update latitude and longitude to UI input field
        document.getElementById("Latitude").value = lat
        document.getElementById("Longitude").value = long
      
    }

    /**
     *  h - misc debug function
     */
    const miscFunction = async()=>
    {
        const posCenter = await WSM.Geom.Point3d(0,0,0)
        const histID = await FormIt.GroupEdit.GetEditingHistoryID()


       let groupID = await WSM.APICreateGroup(histID,[])
       logMessage('create new group')

       let groupHistoryID = await WSM.APIGetGroupReferencedHistoryReadOnly(histID,groupID)
       logMessage('create new group history')

       WSM.APICreateCylinder(groupHistoryID,posCenter,10,3)



    }



    /**
     *  Log message
     */
    const logMessage = (message) => {
        const li = document.createElement("LI")
        const text = document.createTextNode(message)
        li.appendChild(text)
        document.getElementById("Log").appendChild(li)
    }

    // Trigger execute when the create button is clicked
    document.getElementById("CreateButton").addEventListener("click", create3DContext)

    // Trigger undoLastHistory when the undo button is clicked
    document.getElementById("UndoButton").addEventListener("click", undoLastHistory)

    // Update Coordinates when import coord button is clicked
    document.getElementById("ImportCoord").addEventListener("click", updateCoordinatesFromLocation)

    // temperory function
    document.getElementById("debugButton").addEventListener("click", miscFunction)

}());

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
        convertMetersToFeet: 3.28084 //2.407454667562122//
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
            //undoLastHistory()

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

            const geoFeatures = geoJsonData.features.filter(feature => feature.geometry.type === "Polygon" )
            //console.log(geoFeatures)
            

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

            // h - else statement get rid of extrusion error
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

            const historyID = _.last(state.history)
            const heightInternal = convertMetersToFormItUnits(height)

            // the first item in the array is usually outer boundary
            await Promise.all(polygonsFormIt.map(async (points, index) => {                
                try {
                   
                    const groupID = await WSM.APICreateGroup(historyID,[])
             
                    const groupHistoryID = await WSM.APIGetGroupReferencedHistoryReadOnly(historyID , groupID)
                 
                        
                    const allPts = await points

                    const allPL = []

                    for(let i=0;i< allPts.length;i++)
                    {
                        let k = (i + 1 +  allPts.length) %  allPts.length 
                        const pl = WSM.APIConnectPoint3ds(historyID, allPts[i],  allPts[k])
                        //allPL.push(pl)                        
                    }

                    //const result = await Promise.all(allPL)
                    //console.log(result)

                    const faces= await WSM.APIGetAllObjectsByTypeReadOnly(0, WSM.nObjectType.nFaceType);
                    const aface = faces[0];

                    console.log(aface)

                    const faceHistID = await FormIt.GroupEdit.GetEditingHistoryID()

                    await WSM.APIDragFace(faceHistID, aface, heightInternal )                       
                          
                    // Create extrusions
                   // return  WSM.APICreateExtrusion(historyID,  await points, heightInternal)  

                   console.log(aface)
                }
                catch (e) {
                    throw 'Failed to create extrusion'
                }
            }))


        }))

        logMessage(`Created ${(await geometryFormIt).length} features`)
    }

    const jointPoints = async(points, historyID)=>
    {
        const groupID = await WSM.APICreateGroup(historyID,[])
        //logMessage('1. create new group')
         
        const groupHistoryID = await WSM.APIGetGroupReferencedHistoryReadOnly(historyID,groupID)

        for(let i=0;i<points.length;i++)
        {           

            let j=(i+1+points.length)%points.length

            await WSM.APIConnectPoint3ds(groupHistoryID, await points[i], await points[j])
        }    
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
    //     const posCenter = await WSM.Geom.Point3d(0,0,0)
    //     const histID = await FormIt.GroupEdit.GetEditingHistoryID()

    //    let groupID = await WSM.APICreateGroup(histID,[])
    //    logMessage('create new group'+': '+histID)

    //    let groupHistoryID = await WSM.APIGetGroupReferencedHistoryReadOnly(histID,groupID)
    //    logMessage('create new group history'+': '+groupHistoryID)

    //    WSM.APICreateCylinder(groupHistoryID,posCenter,10,3)

    //    WSM.APICreateCylinder(histID,await WSM.Geom.Point3d(4,4,0),10,3)


  
    //Draw polylines

    const histID = await FormIt.GroupEdit.GetEditingHistoryID()

    const ptsForPolyline=[]

    for(let i=0;i<10;i++)
    {
        const pt = await WSM.Geom.Point3d(i*100,i*20,0)
        console.log(pt)

        ptsForPolyline.push(pt)
    }

    for(let i=0;i<10;i++)
    {
        const pt = await WSM.Geom.Point3d(0,i*50,0)
        console.log(pt)

        ptsForPolyline.push(pt)
    }

    ptsForPolyline.push(await WSM.Geom.Point3d(0,450,0))
    ptsForPolyline.push(await WSM.Geom.Point3d(900,180,0))

    for(let i=0;i<ptsForPolyline.length;i++)
    {
        let j=(i+1+ptsForPolyline.length)%ptsForPolyline.length

        await WSM.APIConnectPoint3ds(histID,  ptsForPolyline[i],  ptsForPolyline[j])

    }

    //const pl =  await WSM.APICreatePolyline(histID, await ptsForPolyline, false)

    const pl2pt=[]

    const pt1 = await WSM.Geom.Point3d(100,200,0)
    const pt2 = await WSM.Geom.Point3d(300,300,0)
    const pt3 = await WSM.Geom.Point3d(200,100,0)  

    pl2pt.push( pt1)
    pl2pt.push( pt2)
    pl2pt.push( pt3)
    pl2pt.push( pt1)
    
    const line2histID = await FormIt.GroupEdit.GetEditingHistoryID()

    //const pl2 =  await WSM.APICreatePolyline(line2histID, await pl2pt, false)


    for(let i=0;i<pl2pt.length;i++)
    {
        let j=(i+1+pl2pt.length)%pl2pt.length

        await WSM.APIConnectPoint3ds(line2histID,  pl2pt[i],  pl2pt[j])
    }
    
    // // console.log(WSM.APIGetGroupReferencedHistoryReadOnly(hist,obj,WSM.nObjectType.nFaceType,true))

    // // const hist =  FormIt.Selection.GetSelections()[0].ids[0].History;
    // // console.log(hist)

    // // const object = FormIt.Selection.GetSelections()[0].ids[0].Object;
    // // console.log(object)
    // //console.log(WSM.APIGetObjectsByTypeReadOnly(hisotry, object, WSM.nObjectType.nFaceType, true));

    // const  faces = console.log(await WSM.APIGetAllObjectsByTypeReadOnly(0, 6, WSM.nObjectType.nFaceType,true));
    // console.log(faces[0])

    // const edges= await WSM.APIGetAllObjectsByTypeReadOnly(0, WSM.nObjectType.nEdgeType);
    // const anEdge = edges[0];

    // console.log(edges)

    const faces= await WSM.APIGetAllObjectsByTypeReadOnly(0, WSM.nObjectType.nFaceType);
    const aface = faces[0];

    console.log(aface)

    const faceHistID = await FormIt.GroupEdit.GetEditingHistoryID()
    
    const extrudeFace =  WSM.APIDragFace(faceHistID,aface, -500 )
    
    // await WSM.APICreateExtrusion(faceHistID,await newpts,1000)

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

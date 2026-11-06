const express = require('express');
const cors = require('cors');
const https = require('https');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const fs = require('fs');
const csv = require('csv-parser');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK for secure server-side checks
admin.initializeApp({
  credential: admin.credential.applicationDefault()
});
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3333;
const BKK_API_KEY = '204dc94e-0379-4403-af32-888232066de5'; // Replace if needed

// Enable CORS for all origins (fixes your frontend CORS block)
app.use(cors());
app.use(express.json()); // Required to parse JSON request bodies

const routeDetailsMap = new Map();

// Helper function to customize line name display
function getDisplayLine(routeNumber) {
  const line = String(routeNumber).trim();
  
  if (line === '100E' || line.includes('100E')) {
    return 'AIRPORT EXPRESS';
  }
  
  if (!line || line === 'Transit') {
    return 'Transit'; 
  }

  return line;
}

// Helper function to guess vehicle model based on plate prefix
function getVehicleModel(licensePlate) {
  if (!licensePlate || licensePlate === 'N/A') return 'Unknown Model';
  const plate = licensePlate.toUpperCase();

  if (plate.startsWith('NCG') || plate.startsWith('MZE') || plate.startsWith('PHC') || plate.startsWith('PDN')) {
    return 'Mercedes-Benz Conecto';
  } else if (plate.startsWith('SEF') || plate.startsWith('MHU')) {
    return 'MAN / Volvo Hybrid';
  } else if (plate.startsWith('20-') || plate.startsWith('30-')) {
    return 'CAF Urbos Tram';
  }
  return 'BKK Transit Fleet';
}

async function loadStaticRoutes() {
  console.log('Loading routes.txt...');
  return new Promise((resolve) => {
    if (!fs.existsSync('routes.txt')) return resolve();
    fs.createReadStream('routes.txt')
      .pipe(csv())
      .on('data', (row) => {
        if (row.route_id) {
          routeDetailsMap.set(row.route_id, {
            shortName: row.route_short_name || row.route_id,
            type: parseInt(row.route_type, 10)
          });
        }
      })
      .on('end', () => {
        console.log(`Loaded ${routeDetailsMap.size} route mappings.`);
        resolve();
      });
  });
}

app.use(express.static('public'));

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// --- SECURE ADMIN PROMOTION ENDPOINT ---
app.post('/api/set-admin', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: No token provided' });
        }

        const token = authHeader.split('Bearer ')[1];
        const decodedToken = await admin.auth().verifyIdToken(token);

        // Verify that the person making the request is actually an admin in Firestore
        const requesterDoc = await db.collection('users').doc(decodedToken.uid).get();
        if (!requesterDoc.exists || !requesterDoc.data().admin) {
            return res.status(403).json({ error: 'Forbidden: Only admins can perform this action' });
        }

        const { targetUid, makeAdmin } = req.body;
        if (!targetUid || typeof makeAdmin !== 'boolean') {
            return res.status(400).json({ error: 'Invalid request parameters' });
        }

        // Apply secure Firebase Auth Custom Claims & update Firestore document
        await admin.auth().setCustomUserClaims(targetUid, { admin: makeAdmin });
        await db.collection('users').doc(targetUid).update({ admin: makeAdmin });

        res.json({ success: true, message: 'User role updated successfully.' });
    } catch (error) {
        console.error('Error updating role:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/buses', async (req, res) => {
  try {
    const url = `https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb?key=${BKK_API_KEY}`;
    const buffer = await fetchBuffer(url);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);

    const activeVehicles = [];

    feed.entity.forEach((entity) => {
      if (!entity.vehicle || !entity.vehicle.position) return;

      const v = entity.vehicle;
      const rawRouteId = v.trip?.routeId || '';
      const routeInfo = routeDetailsMap.get(rawRouteId) || { shortName: rawRouteId.replace(/[\[\]]/g, ''), type: 3 };

      let rawLabel = v.vehicle?.label || '';
      let rawPlate = v.vehicle?.licensePlate || '';

      if (!rawPlate) {
        if (v.vehicle?.id) {
          rawPlate = v.vehicle.id;
        } else if (entity.id) {
          rawPlate = entity.id;
        } else if (rawLabel) {
          const match = rawLabel.match(/\[(.*?)\]/);
          if (match && match[1]) {
            rawPlate = match[1];
          }
        }
      }

      let cleanPlate = String(rawPlate).replace(/[\[\]]/g, '').trim() || 'N/A';
      let cleanRoute = String(routeInfo.shortName || rawRouteId).replace(/[\[\]]/g, '').trim() || 'N/A';
      let cleanDest = rawLabel.replace(/\[.*?\]/g, '').replace(/[\[\]]/g, '').trim() || 'In Service';

      let vehicleType = 'bus';
      if (routeInfo.type === 0 || cleanRoute === '4' || cleanRoute === '6') vehicleType = 'tram';
      else if (routeInfo.type === 11 || (Number(cleanRoute) >= 70 && Number(cleanRoute) <= 83)) vehicleType = 'trolley';

      activeVehicles.push({
        id: String(entity.id || v.vehicle?.id || Math.random()),
        routeNumber: getDisplayLine(cleanRoute),
        destination: cleanDest,
        licensePlate: cleanPlate,
        vehicleModel: getVehicleModel(cleanPlate),
        vehicleType: vehicleType,
        latitude: v.position.latitude,
        longitude: v.position.longitude
      });
    });

    res.json(activeVehicles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

loadStaticRoutes().then(() => {
  app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
});

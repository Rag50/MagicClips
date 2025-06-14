
const functions = require('firebase-functions');
const admin = require('firebase-admin');

const { processClips } = require('./magic');

admin.initializeApp();

const db = admin.firestore();
const bucket = admin.storage().bucket();


exports.processVideo = functions.https.onRequest(async (req, res) => {
    try {
        const { userId, inputVideoUrl } = req.body;
        if (!userId || !inputVideoUrl) {
            return res.status(400).json({ error: 'userId and inputVideoUrl required' });
        }


        const processedUrls = await processClips(inputVideoUrl);


        const userRef = db.collection('users').doc(userId);
        const userSnap = await userRef.get();
        const userType = userSnap.exists ? userSnap.data().type : 'free';
        const ttlHours = userType === 'premium' ? 24 : 1;


        const createdAt = admin.firestore.Timestamp.now();
        const expireAt = admin.firestore.Timestamp.fromDate(
            new Date(Date.now() + ttlHours * 3600 * 1000)
        );


        const clipRef = userRef.collection('clips').doc();
        await clipRef.set({
            inputVideoUrl,
            clipUrls: processedUrls,
            createdAt,
            expireAt,
            userType
        });

        return res.json({ clips: processedUrls });
    } catch (err) {
        console.error('processVideo error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});


exports.scheduledCleanup = functions.pubsub
    .schedule('every 15 minutes')
    .onRun(async () => {
        const now = admin.firestore.Timestamp.now();
        const expired = await db
            .collectionGroup('clips')
            .where('expireAt', '<=', now)
            .get();

        const deletes = [];
        expired.forEach(docSnap => {
            const data = docSnap.data();
            const urls = [data.inputVideoUrl, ...data.clipUrls];
            urls.forEach(url => {
                try {
                    const path = decodeURIComponent(url.split('/o/')[1].split('?')[0]);
                    deletes.push(bucket.file(path).delete());
                } catch (e) {
                    console.error('delete file error:', e);
                }
            });
            deletes.push(docSnap.ref.delete());
        });

        await Promise.all(deletes);
        console.log(`Removed ${expired.size} expired clips.`);
        return null;
    });
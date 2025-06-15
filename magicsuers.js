require('dotenv').config();
const express = require('express');
const { spawn, exec } = require('child_process');
const { OpenAI } = require('@azure/openai');
const fs = require('fs').promises;
const fsf = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;
const FormData = require('form-data');
const axios = require('axios');
const { tmpName } = require('tmp-promise');
const SrtParser = require('srt-parser-2').default;
const parser = new SrtParser();
const ffmpeg = require('fluent-ffmpeg');
const { uploadToAzure, deleteLocalFile } = require('./azureStorage')
const FFMPEG_PATH = 'ffmpeg';
const cors = require('cors');

// Firebase imports
const admin = require('firebase-admin');
const serviceAccount = require('./caps-85254-firebase-adminsdk-31j3r-0edeb4bd98.json'); // Add your Firebase service account key

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://caps-85254.firebaseio.com" 
});

const db = admin.firestore();

app.use(express.json());
app.use(cors());
const pythonPath = path.join(__dirname, 'venv', 'bin', 'python');

// Store session data (in production, use Redis or database)
const sessionStore = new Map();

// User tier constants
const USER_TIERS = {
    FREE: 'free',
    PREMIUM: 'premium'
};

const STORAGE_DURATION = {
    [USER_TIERS.FREE]: 1 * 60 * 60 * 1000, // 1 hour in milliseconds
    [USER_TIERS.PREMIUM]: 24 * 60 * 60 * 1000 // 24 hours in milliseconds
};

// ===================================================================
// Firebase Helper Functions
// ===================================================================
async function getUserTier(userId) {
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            return userData.usertype || USER_TIERS.FREE;
        }
        return USER_TIERS.FREE;
    } catch (error) {
        console.error('Error fetching user tier:', error);
        return USER_TIERS.FREE;
    }
}

async function saveVideoToFirebase(userId, videoData, videoType = 'generated') {
    try {
        const userTier = await getUserTier(userId);
        const expiresAt = new Date(Date.now() + STORAGE_DURATION[userTier]);

        const videoDoc = {
            userId,
            videoType, // 'generated' or 'exported'
            ...videoData,
            userTier,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt,
            isActive: true
        };

        const docRef = await db.collection('users').doc(userId).collection('clips').add(videoDoc);

        console.log(`Video saved to Firebase with ID: ${docRef.id} for user: ${userId} (${userTier})`);
        return docRef.id;
    } catch (error) {
        console.error('Error saving video to Firebase:', error);
        throw error;
    }
}

async function updateVideoInFirebase(userId, docId, updateData) {
    try {
        await db.collection('users').doc(userId).collection('clips').doc(docId).update({
            ...updateData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Video updated in Firebase: ${docId} for user: ${userId}`);
    } catch (error) {
        console.error('Error updating video in Firebase:', error);
        throw error;
    }
}

async function getUserVideos(userId, limit = 50) {
    try {
        const snapshot = await db.collection('users').doc(userId).collection('clips')
            .where('isActive', '==', true)
            .orderBy('createdAt', 'desc')
            .limit(limit)
            .get();

        const videos = [];
        snapshot.forEach(doc => {
            videos.push({
                id: doc.id,
                ...doc.data(),
                createdAt: doc.data().createdAt?.toDate(),
                expiresAt: doc.data().expiresAt?.toDate()
            });
        });

        return videos;
    } catch (error) {
        console.error('Error fetching user videos:', error);
        return [];
    }
}

// ===================================================================
// Quality Options Endpoint
// ===================================================================
app.get('/api/quality-options', (req, res) => {
    res.json({
        options: {
            quality: [
                { value: 'ultra', label: 'Ultra High (CRF 15)', description: 'Best quality, larger files' },
                { value: 'high', label: 'High Quality (CRF 18)', description: 'Excellent quality, balanced' },
                { value: 'medium', label: 'Medium Quality (CRF 23)', description: 'Good quality, smaller files' },
                { value: 'low', label: 'Low Quality (CRF 28)', description: 'Fast processing, smallest files' }
            ],
            preset: [
                { value: 'veryslow', label: 'Very Slow', description: 'Best compression efficiency' },
                { value: 'slower', label: 'Slower', description: 'Better compression' },
                { value: 'slow', label: 'Slow', description: 'Good compression' },
                { value: 'medium', label: 'Medium', description: 'Balanced speed/quality' },
                { value: 'fast', label: 'Fast', description: 'Faster processing' }
            ],
            resolution: [
                { value: '4k', label: '4K (2160x3840)', description: 'Ultra HD vertical' },
                { value: '2k', label: '2K (1440x2560)', description: 'High resolution vertical' },
                { value: '1080p', label: '1080p (1080x1920)', description: 'Full HD vertical' },
                { value: '720p', label: '720p (720x1280)', description: 'HD vertical' }
            ],
            bitrate: [
                { value: 'auto', label: 'Auto', description: 'CRF-based quality' },
                { value: 'high', label: 'High (8000k)', description: '8 Mbps' },
                { value: 'medium', label: 'Medium (5000k)', description: '5 Mbps' },
                { value: 'low', label: 'Low (3000k)', description: '3 Mbps' }
            ],
            language: [
                { value: 'english', label: 'English', description: 'Keep original English subtitles' },
                { value: 'hinglish', label: 'Hinglish', description: 'Convert to Hindi-English mix' }
            ]
        }
    });
});

// ===================================================================
// Clip Generation Endpoint (Enhanced with Firebase)
// ===================================================================
app.post('/api/generate-clips', async (req, res) => {
    try {
        const {
            userId, // Required: User ID from frontend
            youtubeUrl,
            videoFormat = 'vertical',
            qualityOptions = {},
            language = 'english'
        } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        if (!youtubeUrl) {
            return res.status(400).json({ error: 'YouTube URL is required' });
        }

        console.log('Starting clip generation for user:', userId, 'URL:', youtubeUrl);

        // Get user tier for storage duration
        const userTier = await getUserTier(userId);
        console.log(`User ${userId} has ${userTier} tier`);

        // Download video
        const videoPath = await downloadYouTubeVideo(youtubeUrl);
        console.log('Video downloaded:', videoPath);

        // Analyze video for face detection and speaker identification
        const faceAnalysis = await analyzeFacesInVideo(videoPath);
        console.log('Face analysis complete:', faceAnalysis.speakers.length, 'speakers detected');

        // Process video and get transcription
        let isoneWord = true;
        let transcription = await processVideoInput(videoPath, isoneWord);

        // Generate SRT content
        let srtContent;
        if (isoneWord) {
            srtContent = generateSRTFromWords(transcription.words);
        } else {
            srtContent = generateSRTNormal(transcription.segments, 4);
        }

        console.log('SRT generated');

        // Convert to Hinglish if requested
        if (language === 'hinglish') {
            console.log('Converting SRT to Hinglish...');
            srtContent = await convertSRTToHinglish(srtContent);
            console.log('Hinglish conversion complete');
        }

        // Analyze SRT with GPT to get viral clips
        const clipTimestamps = await analyzeSRTWithGPT(srtContent, 'podcast');
        const parsedClips = JSON.parse(clipTimestamps);

        console.log('GPT analysis complete, found clips:', parsedClips.clips.length);

        // Generate vertical clips with face tracking and quality options
        const clipResults = await generateVerticalClips(parsedClips, videoPath, srtContent, faceAnalysis, qualityOptions);

        // Create session for this generation
        const sessionId = generateSessionId();
        sessionStore.set(sessionId, {
            userId,
            videoPath,
            srtContent,
            faceAnalysis,
            videoFormat,
            qualityOptions,
            language,
            userTier,
            createdAt: Date.now()
        });

        // Save to Firebase
        const firebaseData = {
            sessionId,
            youtubeUrl,
            videoFormat,
            qualityOptions,
            language,
            clips: clipResults.map(clip => ({
                index: clip.index,
                start: clip.start,
                end: clip.end,
                reason: clip.reason,
                videoUrl: clip.videoUrl,
                duration: clip.duration,
                format: clip.format
            })),
            speakers: faceAnalysis.speakers,
            totalClips: clipResults.length,
            processingCompleted: true
        };

        const firebaseDocId = await saveVideoToFirebase(userId, firebaseData, 'generated');

        // Set up automatic cleanup based on user tier
        const cleanupDelay = STORAGE_DURATION[userTier];
        setTimeout(async () => {
            await cleanupUserVideo(userId, firebaseDocId, sessionId);
        }, cleanupDelay);

        res.json({
            sessionId,
            firebaseDocId,
            clips: clipResults,
            speakers: faceAnalysis.speakers,
            videoFormat,
            qualityOptions,
            language,
            userTier,
            expiresIn: cleanupDelay
        });

    } catch (error) {
        console.error('Error generating clips:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===================================================================
// Clip Export Endpoint (Enhanced with Firebase)
// ===================================================================
app.post('/api/export-clip', async (req, res) => {
    try {
        const {
            userId, // Required: User ID
            sessionId,
            clipIndex,
            subtitleStyle = {},
            faceTrackingOptions = {},
            videoFormat = 'vertical',
            qualityOptions = {}
        } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        if (!sessionId || clipIndex === undefined) {
            return res.status(400).json({ error: 'Session ID and clip index are required' });
        }

        const session = sessionStore.get(sessionId);
        if (!session) {
            return res.status(404).json({ error: 'Session not found or expired' });
        }

        // Verify user owns this session
        if (session.userId !== userId) {
            return res.status(403).json({ error: 'Unauthorized access to session' });
        }

        // Get clip data from session
        const clipTimestamps = await analyzeSRTWithGPT(session.srtContent, 'podcast');
        const parsedClips = JSON.parse(clipTimestamps);

        if (clipIndex >= parsedClips.clips.length) {
            return res.status(400).json({ error: 'Invalid clip index' });
        }

        const selectedClip = parsedClips.clips[clipIndex];

        // Merge session quality options with request quality options
        const finalQualityOptions = { ...session.qualityOptions, ...qualityOptions };

        // Generate clip with custom styling
        const styledClipUrl = await generateAdvancedStyledClip(
            selectedClip,
            session.videoPath,
            session.srtContent,
            session.faceAnalysis,
            subtitleStyle,
            faceTrackingOptions,
            videoFormat,
            finalQualityOptions
        );

        // Save exported clip to Firebase
        const exportData = {
            sessionId,
            originalClipIndex: clipIndex,
            exportedVideoUrl: styledClipUrl,
            subtitleStyle,
            faceTrackingOptions,
            videoFormat,
            qualityOptions: finalQualityOptions,
            selectedClip,
            isExported: true
        };

        const exportDocId = await saveVideoToFirebase(userId, exportData, 'exported');

        // Set up cleanup for exported video
        const userTier = await getUserTier(userId);
        const cleanupDelay = STORAGE_DURATION[userTier];
        setTimeout(async () => {
            await cleanupUserVideo(userId, exportDocId, null, styledClipUrl);
        }, cleanupDelay);

        res.json({
            downloadUrl: styledClipUrl,
            firebaseDocId: exportDocId,
            clip: selectedClip,
            qualityOptions: finalQualityOptions,
            language: session.language || 'english',
            userTier,
            expiresIn: cleanupDelay
        });

    } catch (error) {
        console.error('Error exporting clip:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===================================================================
// User Management Endpoints
// ===================================================================
app.get('/api/user/:userId/videos', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 20 } = req.query;

        const videos = await getUserVideos(userId, parseInt(limit));
        const userTier = await getUserTier(userId);

        res.json({
            videos,
            userTier,
            totalVideos: videos.length
        });
    } catch (error) {
        console.error('Error fetching user videos:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/user/:userId/tier', async (req, res) => {
    try {
        const { userId } = req.params;
        const userTier = await getUserTier(userId);
        const storageDuration = STORAGE_DURATION[userTier];

        res.json({
            userId,
            tier: userTier,
            storageDurationMs: storageDuration,
            storageDurationHours: storageDuration / (60 * 60 * 1000)
        });
    } catch (error) {
        console.error('Error fetching user tier:', error);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/user/:userId/video/:docId', async (req, res) => {
    try {
        const { userId, docId } = req.params;

        // Delete from Firebase
        await db.collection('users').doc(userId).collection('clips').doc(docId).update({
            isActive: false,
            deletedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, message: 'Video marked as deleted' });
    } catch (error) {
        console.error('Error deleting video:', error);
        res.status(500).json({ error: error.message });
    }
});

// ===================================================================
// Cleanup Functions
// ===================================================================
async function cleanupUserVideo(userId, firebaseDocId, sessionId = null, videoUrl = null) {
    try {
        console.log(`Starting cleanup for user: ${userId}, doc: ${firebaseDocId}`);

        // Mark as expired in Firebase
        await db.collection('users').doc(userId).collection('clips').doc(firebaseDocId).update({
            isActive: false,
            expiredAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Clean up session if provided
        if (sessionId && sessionStore.has(sessionId)) {
            const session = sessionStore.get(sessionId);
            if (session.videoPath) {
                await deleteLocalFile(session.videoPath).catch(err =>
                    console.error('Error deleting session video:', err)
                );
            }
            sessionStore.delete(sessionId);
        }

        // Delete video from Azure if URL provided
        if (videoUrl) {
            // Extract blob name from URL and delete from Azure
            try {
                const urlParts = videoUrl.split('/');
                const blobName = urlParts.slice(-2).join('/'); // Get container/filename
                // Add Azure blob deletion logic here if needed
                console.log(`Video URL marked for cleanup: ${videoUrl}`);
            } catch (error) {
                console.error('Error cleaning up video URL:', error);
            }
        }

        console.log(`Cleanup completed for user: ${userId}, doc: ${firebaseDocId}`);
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
}

// Periodic cleanup of expired videos
setInterval(async () => {
    try {
        console.log('Running periodic cleanup of expired videos...');

        const now = new Date();
        const expiredVideos = await db.collectionGroup('clips')
            .where('isActive', '==', true)
            .where('expiresAt', '<=', now)
            .limit(100)
            .get();

        for (const doc of expiredVideos.docs) {
            const data = doc.data();
            const userPath = doc.ref.parent.parent;
            const userId = userPath.id;

            await cleanupUserVideo(userId, doc.id, null, data.exportedVideoUrl);
        }

        console.log(`Cleaned up ${expiredVideos.size} expired videos`);
    } catch (error) {
        console.error('Error in periodic cleanup:', error);
    }
}, 60 * 60 * 1000); // Run every hour

// Clean up expired sessions (existing logic, kept for compatibility)
setInterval(() => {
    const now = Date.now();
    const expireTime = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, session] of sessionStore.entries()) {
        if (now - session.createdAt > expireTime) {
            deleteLocalFile(session.videoPath).catch(() => { });
            sessionStore.delete(sessionId);
        }
    }
}, 10 * 60 * 1000); // Check every 10 minutes

// ===================================================================
// Hinglish Conversion Function (Unchanged)
// ===================================================================
async function convertSRTToHinglish(srtContent) {
    const prompt = `Convert the following English SRT subtitles to Hinglish (Hindi-English mix) while maintaining the exact same timing and structure.

RULES:
1. Keep the SRT format exactly the same (timestamps, numbering)
2. Convert English text to natural Hinglish mix
3. Use Roman script (no Devanagari)
4. Mix Hindi and English words naturally as Indians speak
5. Keep technical terms in English
6. Make it sound conversational and authentic
7. Preserve meaning and context completely

Examples of conversion:
- "How are you doing?" → "Kaise ho aap? How's everything?"
- "That's really good" → "Ye toh bahut accha hai"
- "I think we should go now" → "Mujhe lagta hai ab hum chalte hain"
- "This is amazing work" → "Ye toh kamaal ka kaam hai"

SRT Content:
"""
${srtContent}
"""

Return ONLY the converted SRT content with same format:`;

    const url = `https://cheta-m9rbttyh-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2025-01-01-preview`;

    const data = {
        messages: [
            { role: 'user', content: prompt }
        ],
        max_tokens: 8000,
        temperature: 0.3
    };

    const headers = {
        'Content-Type': 'application/json',
        'api-key': '',
    };

    try {
        const response = await axios.post(url, data, { headers });
        const hinglishSRT = response.data.choices[0].message.content.trim();

        if (!hinglishSRT.includes('-->')) {
            console.error('Invalid SRT format returned from Hinglish conversion');
            return srtContent;
        }

        return hinglishSRT;
    } catch (error) {
        console.error('Error converting to Hinglish:', error.response ? error.response.data : error.message);
        return srtContent;
    }
}

// ===================================================================
// All other existing functions remain unchanged
// ===================================================================

// Face Analysis Function
async function analyzeFacesInVideo(videoPath) {
    return new Promise((resolve, reject) => {
        const outputPath = path.join(__dirname, 'temp', `face_analysis_${Date.now()}.json`);

        const pythonProcess = spawn(pythonPath, ['face_detection.py', videoPath, outputPath]);
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
            console.log('Face detection progress:', data.toString().trim());
        });

        pythonProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        pythonProcess.on('close', async (code) => {
            if (code === 0) {
                try {
                    const analysisData = JSON.parse(await fs.readFile(outputPath, 'utf8'));
                    await deleteLocalFile(outputPath);
                    resolve(analysisData);
                } catch (error) {
                    reject(new Error(`Failed to parse face analysis: ${error.message}`));
                }
            } else {
                reject(new Error(`Face detection failed: ${errorOutput}`));
            }
        });
    });
}

// Clip Generation Functions (with Quality Options)
async function generateVerticalClips(parsedClips, videoPath, srtContent, faceAnalysis, qualityOptions = {}) {
    const subtitles = parser.fromSrt(srtContent);
    const results = [];

    for (let i = 0; i < parsedClips.clips.length; i++) {
        const clip = parsedClips.clips[i];
        try {
            const result = await processVerticalClip(clip, videoPath, subtitles, faceAnalysis, i, qualityOptions);
            results.push(result);
            console.log(`Generated vertical clip ${i + 1}/${parsedClips.clips.length}`);
        } catch (error) {
            console.error(`Failed to process clip ${i}:`, error.message);
        }
    }

    return results;
}

async function processVerticalClip(clip, videoPath, subtitles, faceAnalysis, index, qualityOptions = {}) {
    const clipStart = srtTimeToSeconds(clip.start);
    const clipEnd = srtTimeToSeconds(clip.end);
    const duration = clipEnd - clipStart;

    const clipId = `vertical_${index}_${clip.start.replace(/:/g, '')}-${clip.end.replace(/:/g, '')}`;
    const clipName = `${clipId}.mp4`;
    const clipPath = path.join(__dirname, 'clips', clipName);

    try {
        const clipFaceData = getClipFaceTracking(faceAnalysis, clipStart, clipEnd);
        const cropFilter = buildSmartCropFilter(clipFaceData, duration);
        const qualitySettings = getQualitySettings(qualityOptions);

        const args = [
            '-y',
            '-ss', clip.start,
            '-i', videoPath,
            '-t', duration.toFixed(3),
            '-vf', `${cropFilter},scale=${qualitySettings.resolution}:force_original_aspect_ratio=increase,crop=${qualitySettings.resolution}`,
            '-c:v', 'libx264',
            '-crf', qualitySettings.crf,
            '-preset', qualitySettings.preset,
            '-profile:v', 'high',
            '-level:v', '4.1',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart'
        ];

        if (qualityOptions.bitrate && qualityOptions.bitrate !== 'auto') {
            args.push('-b:v', getBitrateValue(qualityOptions.bitrate));
            args.push('-maxrate', getBitrateValue(qualityOptions.bitrate, 1.5));
            args.push('-bufsize', getBitrateValue(qualityOptions.bitrate, 2));
        }

        args.push('-c:a', 'aac');
        args.push('-b:a', qualitySettings.audioBitrate);
        args.push('-ar', '44100');
        args.push('-ac', '2');
        args.push(clipPath);

        await runFFmpeg(args);

        const azureUrl = await uploadToAzure(clipPath, `clips/${clipName}`);
        console.log('High-quality vertical clip uploaded:', azureUrl);

        await deleteLocalFile(clipPath);

        const clipSRT = await createClipSubtitles(clipStart, clipEnd, subtitles);
        const srtContent = clipSRT.map(sub => ({
            index: sub.id,
            startTime: sub.startTime,
            endTime: sub.endTime,
            timestamp: `${sub.startTime} --> ${sub.endTime}`,
            text: sub.text
        }));

        return {
            index,
            start: clip.start,
            end: clip.end,
            reason: clip.reason,
            videoUrl: azureUrl,
            srt: srtContent,
            duration: duration.toFixed(2),
            format: 'vertical',
            faceTracking: clipFaceData.activeSpeakers,
            quality: qualitySettings
        };
    } catch (error) {
        console.error(`Error processing vertical clip:`, error);
        throw error;
    }
}

// Advanced Clip Generation (with Quality Options)
async function generateAdvancedStyledClip(clip, videoPath, srtContent, faceAnalysis, subtitleStyle, faceTrackingOptions, videoFormat, qualityOptions = {}) {
    const clipStart = srtTimeToSeconds(clip.start);
    const clipEnd = srtTimeToSeconds(clip.end);
    const duration = clipEnd - clipStart;

    const clipId = `advanced_${Date.now()}_${clip.start.replace(/:/g, '')}-${clip.end.replace(/:/g, '')}`;
    const tempSrtPath = path.join(__dirname, 'clips', `temp_${clipId}.srt`);
    const clipName = `${clipId}.mp4`;
    const clipPath = path.join(__dirname, 'clips', clipName);

    try {
        const subtitles = parser.fromSrt(srtContent);
        const subs = await createClipSubtitles(clipStart, clipEnd, subtitles);

        if (subs.length === 0) {
            throw new Error('No subtitles found in clip duration');
        }

        const srtClipContent = subs.map(sub =>
            `${sub.id}\n${sub.startTime} --> ${sub.endTime}\n${sub.text}`
        ).join('\n\n');

        await fs.writeFile(tempSrtPath, srtClipContent);

        const clipFaceData = getClipFaceTracking(faceAnalysis, clipStart, clipEnd);

        const videoFilter = buildAdvancedVideoFilter(
            clipFaceData,
            duration,
            videoFormat,
            faceTrackingOptions,
            tempSrtPath,
            subtitleStyle,
            qualityOptions
        );

        const qualitySettings = getQualitySettings(qualityOptions);

        const args = [
            '-y',
            '-ss', clip.start,
            '-i', videoPath,
            '-t', duration.toFixed(3),
            '-vf', videoFilter,
            '-c:v', 'libx264',
            '-crf', qualitySettings.crf,
            '-preset', qualitySettings.preset,
            '-profile:v', 'high',
            '-level:v', '4.1',
            '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart'
        ];

        if (qualityOptions.bitrate && qualityOptions.bitrate !== 'auto') {
            args.push('-b:v', getBitrateValue(qualityOptions.bitrate));
            args.push('-maxrate', getBitrateValue(qualityOptions.bitrate, 1.5));
            args.push('-bufsize', getBitrateValue(qualityOptions.bitrate, 2));
        }

        args.push('-c:a', 'aac');
        args.push('-b:a', qualitySettings.audioBitrate);
        args.push('-ar', '44100');
        args.push('-ac', '2');
        args.push(clipPath);

        await runFFmpeg(args);

        const azureUrl = await uploadToAzure(clipPath, `exports/${clipName}`);
        console.log('High-quality advanced styled clip uploaded:', azureUrl);

        await deleteLocalFile(clipPath);

        return azureUrl;
    } finally {
        await fs.unlink(tempSrtPath).catch(() => { });
    }
}

// Quality Helper Functions
function getQualitySettings(qualityOptions = {}) {
    const defaults = {
        quality: 'high',
        preset: 'slow',
        resolution: '1080p',
        bitrate: 'auto'
    };

    const options = { ...defaults, ...qualityOptions };

    const crfMap = {
        'ultra': '15',
        'high': '18',
        'medium': '23',
        'low': '28'
    };

    const resolutionMap = {
        '4k': '2160:3840',
        '2k': '1440:2560',
        '1080p': '1080:1920',
        '720p': '720:1280'
    };

    const audioBitrateMap = {
        'ultra': '320k',
        'high': '256k',
        'medium': '192k',
        'low': '128k'
    };

    return {
        crf: crfMap[options.quality] || '18',
        preset: options.preset || 'slow',
        resolution: resolutionMap[options.resolution] || '1080:1920',
        audioBitrate: audioBitrateMap[options.quality] || '256k'
    };
}

function getBitrateValue(bitrateOption, multiplier = 1) {
    const bitrateMap = {
        'high': '8000k',
        'medium': '5000k',
        'low': '3000k'
    };

    const baseBitrate = bitrateMap[bitrateOption] || '5000k';
    const numericValue = parseInt(baseBitrate);

    return Math.round(numericValue * multiplier) + 'k';
}

// ===================================================================
// Advanced Video Processing Functions
// ===================================================================
function buildAdvancedVideoFilter(clipFaceData, duration, videoFormat, faceTrackingOptions, srtPath, subtitleStyle, qualityOptions = {}) {
    const filters = [];

    // 1. Smart cropping based on face tracking
    if (videoFormat === 'vertical') {
        const cropFilter = buildSmartCropFilter(clipFaceData, duration);
        filters.push(cropFilter);

        // Get resolution from quality options
        const qualitySettings = getQualitySettings(qualityOptions);
        filters.push(`scale=${qualitySettings.resolution}:force_original_aspect_ratio=increase`);
        filters.push(`crop=${qualitySettings.resolution}`);
    }

    // 2. Add subtle zoom effects during speaker transitions
    if (faceTrackingOptions.enableZoom !== false) {
        const zoomFilter = buildDynamicZoomFilter(clipFaceData);
        if (zoomFilter) filters.push(zoomFilter);
    }

    // 3. Add subtle blur/focus effects
    if (faceTrackingOptions.enableFocusEffects) {
        filters.push("unsharp=5:5:1.0:5:5:0.0");
    }

    // 4. Enhanced color enhancement for high quality
    if (faceTrackingOptions.enhanceColors !== false) {
        // More sophisticated color grading for high quality clips
        filters.push("eq=contrast=1.15:brightness=0.03:saturation=1.2:gamma=0.95");

        // Add slight sharpening for higher quality settings
        if (qualityOptions.quality === 'ultra' || qualityOptions.quality === 'high') {
            filters.push("unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.8:chroma_msize_x=5:chroma_msize_y=5:chroma_amount=0.4");
        }
    }

    // 5. Noise reduction for cleaner high-quality output
    if (qualityOptions.quality === 'ultra' || qualityOptions.quality === 'high') {
        filters.push("hqdn3d=luma_spatial=4:chroma_spatial=3:luma_tmp=6:chroma_tmp=4.5");
    }

    // 6. Add subtitles with custom positioning
    const style = buildAdvancedSubtitleStyle(subtitleStyle, videoFormat, qualityOptions);
    filters.push(`subtitles=${srtPath}:force_style='${style}'`);

    return filters.join(',');
}

function formatSubtitle(srtContent) {
    const lines = srtContent.split('\n');
    const formattedSubtitles = [];
    let currentSubtitle = {};
    let lineIndex = 0;

    while (lineIndex < lines.length) {
        const line = lines[lineIndex].trim();

        // Skip empty lines
        if (!line) {
            lineIndex++;
            continue;
        }

        // Check if line is a number (subtitle index)
        if (/^\d+$/.test(line)) {
            // Start new subtitle
            currentSubtitle = {
                index: parseInt(line),
                timestamp: '',
                text: ''
            };
            lineIndex++;

            // Next line should be timestamp
            if (lineIndex < lines.length) {
                const timestampLine = lines[lineIndex].trim();
                if (timestampLine.includes('-->')) {
                    const [start, end] = timestampLine.split('-->').map(t => t.trim());
                    currentSubtitle.startTime = start;
                    currentSubtitle.endTime = end;
                    currentSubtitle.timestamp = timestampLine;
                    lineIndex++;

                    // Collect text lines until next empty line or end
                    const textLines = [];
                    while (lineIndex < lines.length && lines[lineIndex].trim() !== '') {
                        textLines.push(lines[lineIndex].trim());
                        lineIndex++;
                    }

                    currentSubtitle.text = textLines.join(' ');

                    if (currentSubtitle.text) {
                        formattedSubtitles.push(currentSubtitle);
                    }
                }
            }
        } else {
            lineIndex++;
        }
    }

    return formattedSubtitles;
}


function buildAdvancedSubtitleStyle(style, videoFormat, qualityOptions = {}) {
    // Scale font size based on resolution
    const resolutionMultiplier = {
        '4k': 1.8,
        '2k': 1.4,
        '1080p': 1.0,
        '720p': 0.8
    };

    const multiplier = resolutionMultiplier[qualityOptions.resolution] || 1.0;

    const defaults = {
        fontName: 'Roboto',
        fontSize: Math.round((videoFormat === 'vertical' ? 32 : 24) * multiplier),
        primaryColor: '&H00FFFFFF',
        outlineColor: '&H00000000',
        backColor: '&H80000000',
        borderStyle: 3,
        outline: Math.round(2 * multiplier),
        shadow: Math.round(1 * multiplier),
        alignment: videoFormat === 'vertical' ? 2 : 2,
        marginV: Math.round((videoFormat === 'vertical' ? 100 : 30) * multiplier),
        marginL: Math.round(20 * multiplier),
        marginR: Math.round(20 * multiplier)
    };

    const finalStyle = { ...defaults, ...style };

    // Convert color format if needed
    if (style.primaryColor && !style.primaryColor.startsWith('&H')) {
        finalStyle.primaryColor = hexToASS(style.primaryColor);
    }
    if (style.outlineColor && !style.outlineColor.startsWith('&H')) {
        finalStyle.outlineColor = hexToASS(style.outlineColor);
    }
    if (style.backColor && !style.backColor.startsWith('&H')) {
        finalStyle.backColor = hexToASS(style.backColor);
    }

    return [
        `FontName=${finalStyle.fontName}`,
        `Fontsize=${finalStyle.fontSize}`,
        `PrimaryColour=${finalStyle.primaryColor}`,
        `OutlineColour=${finalStyle.outlineColor}`,
        `BackColour=${finalStyle.backColor}`,
        `BorderStyle=${finalStyle.borderStyle}`,
        `Outline=${finalStyle.outline}`,
        `Shadow=${finalStyle.shadow}`,
        `Alignment=${finalStyle.alignment}`,
        `MarginV=${finalStyle.marginV}`,
        `MarginL=${finalStyle.marginL}`,
        `MarginR=${finalStyle.marginR}`
    ].join(',');
}

// ===================================================================
// Face Tracking Functions
// ===================================================================
function getClipFaceTracking(faceAnalysis, clipStart, clipEnd) {
    const clipFaces = faceAnalysis.faces.filter(face =>
        face.timestamp >= clipStart && face.timestamp <= clipEnd
    );

    // Group faces by speaker and calculate active speaking periods
    const speakerActivity = {};
    faceAnalysis.speakers.forEach(speaker => {
        speakerActivity[speaker.id] = {
            ...speaker,
            activity: [],
            dominantPeriods: []
        };
    });

    // Analyze face activity in 1-second intervals
    for (let t = clipStart; t < clipEnd; t += 1) {
        const facesAtTime = clipFaces.filter(face =>
            Math.abs(face.timestamp - t) < 0.5
        );

        // Determine most prominent face at this time
        if (facesAtTime.length > 0) {
            const dominantFace = facesAtTime.reduce((prev, current) =>
                (current.confidence > prev.confidence) ? current : prev
            );

            if (speakerActivity[dominantFace.speakerId]) {
                speakerActivity[dominantFace.speakerId].activity.push({
                    time: t - clipStart,
                    face: dominantFace
                });
            }
        }
    }

    // Calculate dominant speaking periods for smooth transitions
    Object.values(speakerActivity).forEach(speaker => {
        if (speaker.activity.length > 0) {
            let currentPeriod = { start: 0, end: 0, speaker: speaker.id };

            speaker.activity.forEach((activity, index) => {
                if (index === 0) {
                    currentPeriod.start = activity.time;
                }

                if (index === speaker.activity.length - 1 ||
                    speaker.activity[index + 1].time - activity.time > 2) {
                    currentPeriod.end = activity.time;
                    speaker.dominantPeriods.push(currentPeriod);
                    currentPeriod = { start: activity.time, end: activity.time, speaker: speaker.id };
                }
            });
        }
    });

    return {
        faces: clipFaces,
        speakers: faceAnalysis.speakers,
        speakerActivity,
        activeSpeakers: Object.values(speakerActivity).filter(s => s.activity.length > 0)
    };
}

function buildSmartCropFilter(clipFaceData, duration) {
    if (!clipFaceData.activeSpeakers.length) {
        // Default center crop if no faces detected
        return "crop=ih*9/16:ih:iw/2-ih*9/32:0";
    }

    // Create dynamic crop based on dominant speakers
    const cropCommands = [];
    let currentTime = 0;

    clipFaceData.activeSpeakers.forEach(speaker => {
        speaker.dominantPeriods.forEach(period => {
            if (period.end - period.start > 1) { // Only use periods longer than 1 second
                const avgFace = calculateAverageFacePosition(speaker.activity);
                const cropX = Math.max(0, avgFace.x - 540); // Center on face, 1080px width
                const cropY = Math.max(0, avgFace.y - 960); // Center vertically, 1920px height

                cropCommands.push(`crop=1080:1920:${cropX}:${cropY}:enable='between(t,${period.start},${period.end})'`);
            }
        });
    });

    if (cropCommands.length > 0) {
        return cropCommands.join(',');
    }

    // Fallback to center crop
    return "crop=ih*9/16:ih:iw/2-ih*9/32:0";
}

function buildDynamicZoomFilter(clipFaceData) {
    if (!clipFaceData.activeSpeakers.length) return null;

    const zoomCommands = [];

    clipFaceData.activeSpeakers.forEach(speaker => {
        speaker.dominantPeriods.forEach(period => {
            if (period.end - period.start > 2) {
                // Subtle zoom in when speaker is active
                zoomCommands.push(
                    `zoompan=z='if(between(t,${period.start},${period.start + 0.5}),zoom+0.02,if(between(t,${period.end - 0.5},${period.end}),zoom-0.02,zoom))':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
                );
            }
        });
    });

    return zoomCommands.length > 0 ? zoomCommands[0] : null; // Use first speaker's zoom pattern
}

function calculateAverageFacePosition(activity) {
    if (!activity.length) return { x: 540, y: 960 }; // Default center

    const avgX = activity.reduce((sum, a) => sum + a.face.x, 0) / activity.length;
    const avgY = activity.reduce((sum, a) => sum + a.face.y, 0) / activity.length;

    return { x: avgX, y: avgY };
}

// ===================================================================
// GPT Analysis Function
// ===================================================================
async function analyzeSRTWithGPT(srtContent, contentType = 'general') {
    const podcastPrompt = contentType === 'podcast' ? `
                    This appears to be podcast content. Focus on:
                    - Compelling questions and answers
                    - Emotional moments and reactions
                    - Controversial or surprising statements
                    - Humorous exchanges between hosts/guests
                    - Key insights and "aha" moments
                    - Dramatic pauses and emphasis
                    - Disagreements or debates
                    ` : '';

    const prompt = `Analyze this SRT file and suggest 4-5 potential viral clips (exactly 30s each) perfect for vertical social media format (TikTok/Instagram Reels).
                    
                    ${podcastPrompt}
                    
                    Follow these rules:
                    1. Identify viral moments that work great in vertical format:
                       - Emotional peaks (surprise, excitement, humor)
                       - Quick wit and clever responses
                       - Controversial or thought-provoking statements
                       - Visual reactions and expressions
                       - Fast-paced exchanges
                    2. Ensure NO overlap between clips
                    3. Prioritize moments that hook viewers in first 3 seconds
                    4. Include exact timestamps matching subtitle boundaries
                    5. Focus on self-contained segments that make sense without context
                    
                    SRT Content:
                    """
                    ${srtContent}
                    """
                    
                    Respond STRICTLY with JSON in this format:
                    {
                      "clips": [
                        {
                          "start": "HH:MM:SS", 
                          "end": "HH:MM:SS",
                          "reason": "specific_viral_factor_description"
                        }
                      ]
                    }`;

    const url = `https://cheta-m9rbttyh-eastus2.cognitiveservices.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2025-01-01-preview`;

    const data = {
        messages: [
            { role: 'user', content: prompt }
        ],
        response_format: { "type": "json_object" }
    };

    const headers = {
        'Content-Type': 'application/json',
        'api-key': 'DszqvR4OsujhU3lpXAdrqp1dCvFUHHEzRxZFXoA2VXvbPtD3jAA0JQQJ99BDACHYHv6XJ3w3AAAAACOG7P1k',
    };

    try {
        const response = await axios.post(url, data, { headers });
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Error calling GPT-4:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// ===================================================================
// Video Analysis Endpoint
// ===================================================================
app.get('/api/video-analysis/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessionStore.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        sessionId,
        speakers: session.faceAnalysis.speakers,
        videoFormat: session.videoFormat,
        qualityOptions: session.qualityOptions || {},
        totalFaces: session.faceAnalysis.faces.length,
        hasMultipleSpeakers: session.faceAnalysis.speakers.length > 1
    });
});

// ===================================================================
// Face Tracking Options Endpoint
// ===================================================================
app.get('/api/face-tracking-options', (req, res) => {
    res.json({
        options: {
            enableFaceTracking: true,
            enableZoom: true,
            enableFocusEffects: false,
            enhanceColors: true,
            subtitlePositions: [
                { value: 'bottom', label: 'Bottom' },
                { value: 'top', label: 'Top' },
                { value: 'middle', label: 'Middle' },
                { value: 'custom', label: 'Custom Position' }
            ],
            cropModes: [
                { value: 'auto', label: 'Auto Face Tracking' },
                { value: 'center', label: 'Center Crop' },
                { value: 'custom', label: 'Custom Position' }
            ]
        }
    });
});

// ===================================================================
// Helper Functions
// ===================================================================
async function initialize() {
    await fs.mkdir('downloads', { recursive: true });
    await fs.mkdir('clips', { recursive: true });
    await fs.mkdir('temp', { recursive: true });
}

function generateSRTFromWords(words) {
    let srt = '';
    let counter = 1;

    words.forEach(word => {
        srt += `${counter}\n`;
        srt += `${formatTime(word.start)} --> ${formatTime(word.end)}\n`;
        srt += `${word.word}\n\n`;
        counter++;
    });

    return srt;
}

function generateSRTNormal(segments, wordLimit) {
    let srt = '';
    let index = 1;

    const validSegments = Array.isArray(segments) ? segments : [];

    validSegments.forEach((segment) => {
        if (
            !segment?.text ||
            typeof segment.start === 'undefined' ||
            typeof segment.end === 'undefined'
        ) {
            return;
        }

        const words = segment.text.split(' ').filter(word => word.trim() !== '');
        const totalWords = words.length;
        const segmentDuration = segment.end - segment.start;

        if (totalWords === 0 || segmentDuration <= 0) return;

        if (wordLimit === 1) {
            const wordDuration = segmentDuration / totalWords;

            words.forEach((word, i) => {
                const startTime = segment.start + (i * wordDuration);
                const endTime = segment.start + ((i + 1) * wordDuration);

                srt += `${index}\n${secondsToSRTTime(startTime)} --> ${secondsToSRTTime(endTime)}\n${word}\n\n`;
                index++;
            });
        } else {
            for (let i = 0; i < totalWords; i += wordLimit) {
                const chunk = words.slice(i, i + wordLimit).join(' ');
                const chunkStart = segment.start + (i / totalWords) * segmentDuration;
                const chunkEnd = segment.start + ((i + wordLimit) / totalWords) * segmentDuration;

                srt += `${index}\n${secondsToSRTTime(chunkStart)} --> ${secondsToSRTTime(chunkEnd)}\n${chunk}\n\n`;
                index++;
            }
        }
    });

    return srt;
}

function formatTime(seconds) {
    const date = new Date(0);
    date.setSeconds(Math.floor(seconds));
    date.setMilliseconds((seconds % 1) * 1000);
    return date.toISOString().substring(11, 23).replace('.', ',');
}

function secondsToSRTTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds);
    const time = date.toISOString().substr(11, 12);
    return time.replace('.', ',');
}

async function callWhisper(audioFilePath, isoneWord) {
    console.log(audioFilePath);
    const url = `https://capsaiendpoint.openai.azure.com/openai/deployments/whisper/audio/transcriptions?api-version=2024-02-15-preview`;

    const formData = new FormData();
    formData.append('file', fsf.createReadStream(audioFilePath), { filename: 'audio.wav' });
    formData.append('response_format', 'verbose_json');

    if (isoneWord) {
        formData.append('timestamp_granularities[]', 'word');
    }

    const headers = {
        ...formData.getHeaders(),
        'api-key': 'F3Fn3CAZEgFTJcstkQidxdoiMwExZ11kiXQHxu04RM2yPCZO0lTQJQQJ99BBAC77bzfXJ3w3AAABACOGUSDo'
    };

    try {
        const response = await axios.post(url, formData, { headers });

        if (response.data.words) {
            response.data.words.forEach(word => {
                console.log(`Word: ${word.word} | Start: ${word.start} | End: ${word.end}`);
            });
        } else {
            console.log('No word-level timestamps in response:', response.data);
        }

        return response.data;
    } catch (error) {
        console.error('Error calling Whisper:', error.response ? error.response.data : error.message);
        throw error;
    }
}

function extractAudioFromVideo(videoFilePath, audioFilePath) {
    return new Promise((resolve, reject) => {
        const command = `ffmpeg -i "${videoFilePath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${audioFilePath}"`;
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('Error extracting audio:', stderr);
                reject(error);
            } else {
                console.log('Audio extracted successfully:', audioFilePath);
                resolve(audioFilePath);
            }
        });
    });
}

async function processVideoInput(videoFilePath, isoneWord) {
    console.log('Processing video input...');
    try {
        console.log('Extracting audio from video...');
        const audioFilePath = 'downloads/extracted-audio.wav';
        await extractAudioFromVideo(videoFilePath, audioFilePath);

        console.log('Sending audio to Whisper API...');
        const srtContent = await callWhisper(audioFilePath, isoneWord);
        console.log('Whisper Transcription completed');

        fsf.unlinkSync(audioFilePath);
        console.log('Temporary audio file deleted.');

        return srtContent;
    } catch (error) {
        console.error('Error processing video input:', error);
        throw error;
    }
}

async function downloadYouTubeVideo(url) {
    return new Promise((resolve, reject) => {
        const pythonProcess = spawn(pythonPath, ['download.py', url]);
        let errorOutput = '';

        pythonProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output.startsWith('VIDEO_PATH:')) {
                resolve(output.split(':')[1].trim());
            }
        });

        pythonProcess.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code !== 0) reject(new Error(`Python script failed: ${errorOutput}`));
        });
    });
}

function srtTimeToSeconds(timeStr) {
    const cleanTime = timeStr.replace(',', '.').replace(/;/g, ':');
    const parts = cleanTime.split(':');

    let seconds = 0;
    if (parts.length === 3) {
        seconds += parseInt(parts[0]) * 3600;
        seconds += parseInt(parts[1]) * 60;
        seconds += parseFloat(parts[2]);
    } else if (parts.length === 2) {
        seconds += parseInt(parts[0]) * 60;
        seconds += parseFloat(parts[1]);
    }

    return seconds;
}

async function createClipSubtitles(clipStart, clipEnd, subtitles) {
    const EPSILON = 0.001;

    const allSubs = subtitles.map(sub => ({
        original: sub,
        start: srtTimeToSeconds(sub.startTime),
        end: srtTimeToSeconds(sub.endTime),
        text: sub.text
    }));

    console.log(`Clip boundaries: ${clipStart.toFixed(3)}-${clipEnd.toFixed(3)}`);

    const filtered = allSubs.filter(({ start, end }) => {
        return (
            (start > clipStart - EPSILON && start < clipEnd + EPSILON) ||
            (end > clipStart - EPSILON && end < clipEnd + EPSILON) ||
            (start <= clipStart && end >= clipEnd)
        );
    });

    if (filtered.length === 0) {
        console.error('No matching subtitles found');
        return '';
    }

    const merged = [];
    let current = null;

    filtered.sort((a, b) => a.start - b.start).forEach(sub => {
        if (!current) {
            current = { ...sub };
        } else if (sub.start <= current.end + EPSILON) {
            current.text += sub.text.trim() ? ` ${sub.text.trim()}` : '';
            current.end = Math.max(current.end, sub.end);
        } else {
            merged.push(current);
            current = { ...sub };
        }
    });
    if (current) merged.push(current);

    return merged.map((sub, index) => {
        const start = Math.max(sub.start - clipStart, 0);
        const end = Math.min(sub.end - clipStart, clipEnd - clipStart);
        const finalEnd = end > start ? end : start + 0.001;

        return {
            id: index + 1,
            startTime: formatSrtTime(start),
            endTime: formatSrtTime(finalEnd),
            text: sub.text
        };
    });
}

function formatSrtTime(seconds) {
    const ms = Math.round((seconds % 1) * 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

function runFFmpeg(args) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(FFMPEG_PATH, args);
        let errorOutput = '';

        ffmpeg.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg failed: ${errorOutput}`));
            }
        });
    });
}

// Convert hex color to ASS format
function hexToASS(hexColor) {
    // Remove # if present
    hexColor = hexColor.replace('#', '');

    // Convert from RGB to BGR (ASS format)
    if (hexColor.length === 6) {
        const r = hexColor.substring(0, 2);
        const g = hexColor.substring(2, 4);
        const b = hexColor.substring(4, 6);
        return `&H00${b}${g}${r}`;
    }

    return '&H00FFFFFF'; // Default to white
}

// Generate unique session ID
function generateSessionId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Clean up expired sessions (run periodically)
setInterval(() => {
    const now = Date.now();
    const expireTime = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, session] of sessionStore.entries()) {
        if (now - session.createdAt > expireTime) {
            deleteLocalFile(session.videoPath).catch(() => { });
            sessionStore.delete(sessionId);
        }
    }
}, 10 * 60 * 1000); // Check every 10 minutes

// ===================================================================
// Additional Endpoints
// ===================================================================
app.get('/api/subtitle-fonts', (req, res) => {
    const fonts = [
        'Arial', 'Roboto', 'Open Sans', 'Lato', 'Montserrat',
        'Source Sans Pro', 'Raleway', 'PT Sans', 'Lora', 'Merriweather',
        'Inter', 'Poppins', 'Nunito', 'Work Sans', 'Fira Sans'
    ];
    res.json({ fonts });
});

app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessionStore.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        sessionId,
        createdAt: session.createdAt,
        hasVideo: !!session.videoPath,
        hasSRT: !!session.srtContent,
        hasFaceAnalysis: !!session.faceAnalysis,
        videoFormat: session.videoFormat,
        qualityOptions: session.qualityOptions || {},
        speakerCount: session.faceAnalysis?.speakers?.length || 0
    });
});

// ===================================================================
// Initialize and Start Server
// ===================================================================
initialize().then(() => {
    app.use('/clips', express.static(path.join(__dirname, 'clips')));
    app.listen(port, () => console.log(`Enhanced Vertical Clips API with Quality Options running on port ${port}`));
});
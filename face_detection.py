import cv2
import json
import sys
import os
import numpy as np
from collections import defaultdict
import face_recognition

def detect_faces_in_video(video_path, output_path):
    """
    Detect and track faces in video for podcast-style content
    Returns face positions, timestamps, and speaker identification
    """
    
    # Open video file
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        print(f"Error: Could not open video file {video_path}")
        return
    
    # Get video properties
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps
    
    print(f"Processing video: {duration:.2f}s, {fps} FPS, {total_frames} frames")
    
    # Initialize face detection
    face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    
    # Storage for face data
    all_faces = []
    known_face_encodings = []
    known_face_names = []
    speaker_id_counter = 1
    
    # Process every 0.5 seconds (2 frames per second for efficiency)
    frame_skip = max(1, int(fps * 0.5))
    
    frame_count = 0
    processed_frames = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Skip frames for efficiency
        if frame_count % frame_skip != 0:
            frame_count += 1
            continue
        
        timestamp = frame_count / fps
        
        # Convert frame to RGB for face_recognition library
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Detect faces using OpenCV (faster for detection)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30)
        )
        
        # Process each detected face
        for (x, y, w, h) in faces:
            # Extract face region for encoding
            face_region = rgb_frame[y:y+h, x:x+w]
            
            # Get face encoding for speaker identification
            try:
                face_locations = [(0, w, h, 0)]  # Convert to face_recognition format
                face_encodings = face_recognition.face_encodings(face_region, face_locations)
                
                if face_encodings:
                    face_encoding = face_encodings[0]
                    
                    # Compare with known faces to identify speaker
                    speaker_id = identify_speaker(face_encoding, known_face_encodings, known_face_names, speaker_id_counter)
                    
                    # If new speaker, add to known faces
                    if speaker_id == f"speaker_{speaker_id_counter}":
                        known_face_encodings.append(face_encoding)
                        known_face_names.append(speaker_id)
                        speaker_id_counter += 1
                    
                    # Calculate face confidence based on size and position
                    confidence = calculate_face_confidence(x, y, w, h, frame.shape)
                    
                    # Store face data
                    face_data = {
                        'timestamp': timestamp,
                        'x': x,
                        'y': y,
                        'width': w,
                        'height': h,
                        'confidence': confidence,
                        'speakerId': speaker_id,
                        'center_x': x + w // 2,
                        'center_y': y + h // 2
                    }
                    
                    all_faces.append(face_data)
                
            except Exception as e:
                print(f"Error processing face at {timestamp:.2f}s: {e}")
        
        processed_frames += 1
        if processed_frames % 10 == 0:
            progress = (frame_count / total_frames) * 100
            print(f"Progress: {progress:.1f}% ({processed_frames} faces processed)")
        
        frame_count += 1
    
    cap.release()
    
    # Create speaker summary
    speakers = create_speaker_summary(all_faces, known_face_names)
    
    # Smooth face tracking data
    smoothed_faces = smooth_face_tracking(all_faces)
    
    # Prepare final output
    analysis_result = {
        'video_duration': duration,
        'total_faces_detected': len(smoothed_faces),
        'speakers': speakers,
        'faces': smoothed_faces,
        'processing_info': {
            'fps': fps,
            'frames_processed': processed_frames,
            'frame_skip': frame_skip
        }
    }
    
    # Save to JSON file
    with open(output_path, 'w') as f:
        json.dump(analysis_result, f, indent=2)
    
    print(f"Face detection complete! Found {len(speakers)} speakers, {len(smoothed_faces)} face instances")
    print(f"Results saved to {output_path}")

def identify_speaker(face_encoding, known_encodings, known_names, next_id):
    """
    Identify speaker by comparing face encoding with known faces
    """
    if not known_encodings:
        return f"speaker_{next_id}"
    
    # Compare face with known faces
    matches = face_recognition.compare_faces(known_encodings, face_encoding, tolerance=0.6)
    distances = face_recognition.face_distance(known_encodings, face_encoding)
    
    # Find best match
    if True in matches:
        best_match_index = np.argmin(distances)
        if matches[best_match_index]:
            return known_names[best_match_index]
    
    # If no match found, it's a new speaker
    return f"speaker_{next_id}"

def calculate_face_confidence(x, y, w, h, frame_shape):
    """
    Calculate confidence score based on face size, position, and clarity
    """
    frame_height, frame_width = frame_shape[:2]
    
    # Size factor (larger faces are more confident)
    size_factor = (w * h) / (frame_width * frame_height)
    
    # Position factor (centered faces are more confident)
    center_x = x + w // 2
    center_y = y + h // 2
    distance_from_center = np.sqrt(
        ((center_x - frame_width // 2) / frame_width) ** 2 +
        ((center_y - frame_height // 2) / frame_height) ** 2
    )
    position_factor = 1 - distance_from_center
    
    # Combine factors
    confidence = (size_factor * 0.7 + position_factor * 0.3) * 100
    return min(100, max(0, confidence))

def create_speaker_summary(faces, known_names):
    """
    Create summary of detected speakers with their statistics
    """
    speaker_stats = defaultdict(lambda: {
        'total_appearances': 0,
        'avg_confidence': 0,
        'first_appearance': float('inf'),
        'last_appearance': 0,
        'avg_position': {'x': 0, 'y': 0}
    })
    
    # Calculate statistics for each speaker
    for face in faces:
        speaker_id = face['speakerId']
        stats = speaker_stats[speaker_id]
        
        stats['total_appearances'] += 1
        stats['avg_confidence'] += face['confidence']
        stats['first_appearance'] = min(stats['first_appearance'], face['timestamp'])
        stats['last_appearance'] = max(stats['last_appearance'], face['timestamp'])
        stats['avg_position']['x'] += face['center_x']
        stats['avg_position']['y'] += face['center_y']
    
    # Finalize averages
    speakers = []
    for speaker_id, stats in speaker_stats.items():
        if stats['total_appearances'] > 0:
            speakers.append({
                'id': speaker_id,
                'appearances': stats['total_appearances'],
                'avg_confidence': stats['avg_confidence'] / stats['total_appearances'],
                'first_seen': stats['first_appearance'],
                'last_seen': stats['last_appearance'],
                'screen_time': stats['last_appearance'] - stats['first_appearance'],
                'avg_position': {
                    'x': stats['avg_position']['x'] / stats['total_appearances'],
                    'y': stats['avg_position']['y'] / stats['total_appearances']
                }
            })
    
    # Sort by screen time (most prominent speakers first)
    speakers.sort(key=lambda x: x['screen_time'], reverse=True)
    
    return speakers

def smooth_face_tracking(faces):
    """
    Smooth out face tracking data to reduce jitter
    """
    if not faces:
        return faces
    
    # Group faces by speaker
    speaker_faces = defaultdict(list)
    for face in faces:
        speaker_faces[face['speakerId']].append(face)
    
    smoothed_faces = []
    
    for speaker_id, speaker_face_list in speaker_faces.items():
        # Sort by timestamp
        speaker_face_list.sort(key=lambda x: x['timestamp'])
        
        # Apply smoothing filter
        for i, face in enumerate(speaker_face_list):
            if i == 0 or i == len(speaker_face_list) - 1:
                # Keep first and last frames as-is
                smoothed_faces.append(face)
            else:
                # Apply simple moving average
                prev_face = speaker_face_list[i - 1]
                next_face = speaker_face_list[i + 1]
                
                smoothed_face = face.copy()
                smoothed_face['x'] = int((prev_face['x'] + face['x'] + next_face['x']) / 3)
                smoothed_face['y'] = int((prev_face['y'] + face['y'] + next_face['y']) / 3)
                smoothed_face['center_x'] = smoothed_face['x'] + smoothed_face['width'] // 2
                smoothed_face['center_y'] = smoothed_face['y'] + smoothed_face['height'] // 2
                
                smoothed_faces.append(smoothed_face)
    
    # Sort by timestamp
    smoothed_faces.sort(key=lambda x: x['timestamp'])
    
    return smoothed_faces

def main():
    if len(sys.argv) != 3:
        print("Usage: python face_detection.py <video_path> <output_json_path>")
        sys.exit(1)
    
    video_path = sys.argv[1]
    output_path = sys.argv[2]
    
    if not os.path.exists(video_path):
        print(f"Error: Video file {video_path} not found")
        sys.exit(1)
    
    # Create output directory if it doesn't exist
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    try:
        detect_faces_in_video(video_path, output_path)
    except Exception as e:
        print(f"Error during face detection: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
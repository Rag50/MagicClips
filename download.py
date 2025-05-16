import yt_dlp
import sys

def download_video(url):
    ydl_opts = {
        'format': 'best',
        'outtmpl': 'downloads/%(id)s.%(ext)s',
        'noplaylist': True,
        'quiet': True
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        file_path = ydl.prepare_filename(info)
        return file_path

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("ERROR: Missing YouTube URL")
        sys.exit(1)
        
    try:
        path = download_video(sys.argv[1])
        print(f"VIDEO_PATH:{path}")
    except Exception as e:
        print(f"ERROR:{str(e)}")
        sys.exit(1)
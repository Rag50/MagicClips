# import yt_dlp
# import sys

# def download_video(url):
#     ydl_opts = {
#         'format': 'best',
#         'outtmpl': 'downloads/%(id)s.%(ext)s',
#         'noplaylist': True,
#         'quiet': True
#     }

#     with yt_dlp.YoutubeDL(ydl_opts) as ydl:
#         info = ydl.extract_info(url, download=True)
#         file_path = ydl.prepare_filename(info)
#         return file_path

# if __name__ == "__main__":
#     if len(sys.argv) != 2:
#         print("ERROR: Missing YouTube URL")
#         sys.exit(1)
        
#     try:
#         path = download_video(sys.argv[1])
#         print(f"VIDEO_PATH:{path}")
#     except Exception as e:
#         print(f"ERROR:{str(e)}")
#         sys.exit(1)

import yt_dlp
import sys

def download_video(url):
    ydl_opts = {
        'format': 'best',
        'outtmpl': 'downloads/%(id)s.%(ext)s',
        'noplaylist': True,
        'quiet': False,          # show logs
        'verbose': True,         # yt-dlp’s own debug output
        'nocheckcertificate': True,  # exactly the Python-API key for --no-check-certificates :contentReference[oaicite:0]{index=0}
        'socket_timeout': 15,    # fail fast if the network is flaky
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        # use .download() just like the CLI
        ydl.download([url])
        info = ydl.extract_info(url, download=False)
        return ydl.prepare_filename(info)

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("ERROR: Missing YouTube URL")
        sys.exit(1)
    try:
        path = download_video(sys.argv[1])
        print(f"VIDEO_PATH: {path}")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)

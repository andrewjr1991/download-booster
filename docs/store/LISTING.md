# Store listing · 商店资料

What to fill in on the Chrome Web Store developer dashboard (and the Edge Add-ons Partner Center, which asks for the same things). Images are in `docs/store/zh_CN/` and `docs/store/en/`; `tools/make-icon128.py` draws the icon and `test/store-shots.mjs` takes the screenshots again after UI changes.

## Package

- Upload: `download-booster-1.1.0.zip` (manifest.json, _locales, src, icons; nothing else).
- Default language: English. Chinese (zh_CN) listing added as a second language.
- Category: Tools (工具).
- Privacy policy URL: https://github.com/andrewjr1991/download-booster/blob/main/docs/store/PRIVACY.md
- Homepage / support URL: https://github.com/andrewjr1991/download-booster

## Images

| Store field | File |
| --- | --- |
| Store icon 128×128 | `icons/icon128.png` (96×96 artwork with 16 px padding) |
| Screenshots 1280×800 (up to 5) | `1-downloads.png`, `2-sniff.png`, `3-m3u8.png`, `4-settings.png` |
| Small promo tile 440×280 | `promo-small-440x280.png` |
| Marquee promo tile 1400×560 (optional) | `promo-marquee-1400x560.png` |

## English

**Name** (from the manifest): Download Booster – Multi-connection Downloads

**Summary** (from the manifest, 132 characters max): Download large files faster with adaptive multi-connection downloads, pause and resume. No extra software needed.

**Description:**

```
Download Booster makes large downloads faster without installing a separate download manager. It splits a file into pieces and downloads them over several connections at once, so a single slow connection no longer limits your speed.

FASTER DOWNLOADS
• Up to 6 connections per file from the start; fewer only when the server refuses more
• Slow connections are spotted and replaced, and the last pieces are split finer so a download doesn't crawl at the end
• Pause and resume, also after closing the browser
• Every byte is checked before the file is saved
• Optional mirrors: other addresses of the same file share the work
• Optional MD5 / SHA-1 / SHA-256 check when the download finishes

VIDEOS, AUDIO AND IMAGES ON A PAGE
• The toolbar button lists the videos, audio, images and m3u8/DASH playlists a page has loaded, including ones the player fetches in the background
• Preview before downloading, select several and download them together
• m3u8 (HLS) and DASH streams: pick a quality; pieces are downloaded in parallel, AES-128 encrypted pieces are decrypted, and everything is joined into one file
• Record a video that plays from a blob: address and save it as MP4

YOUR WAY
• Takes over browser downloads above a size you choose, or only the ones you send to it
• Global speed limit and number of downloads at once
• Save straight into a folder you pick
• Search and filter your downloads; open a finished file, copy its link or download it again
• Optional notification when a download finishes or fails
• Batch download every link on a page, with filters and renaming
• English and Chinese

PRIVATE
No account, no ads, no tracking. Everything stays in your browser; the extension only connects to the files you download.

Not supported: DRM-protected video, live streams, and YouTube.
```

## 中文

**名称**（来自清单）：下载加速器 – 多连接分段下载

**简介**（来自清单）：用自适应多连接分段下载加速大文件，支持暂停与续传，无需安装其他软件。

**详细说明：**

```
下载加速器让大文件下载更快，不用另外安装下载软件。它把文件分成多段，同时用多个连接下载，一个慢连接不再拖住整个下载。

下载更快
• 每个文件一开始就用最多 6 个连接，服务器拒绝时才减少
• 自动发现并换掉慢连接，最后一部分拆得更细，不会在结尾卡很久
• 支持暂停和续传，关掉浏览器后也能接着下
• 保存前逐字节检查文件是否完整
• 可以填写同一文件的镜像地址，多个服务器一起下
• 可以在下完后自动核对 MD5 / SHA-1 / SHA-256

网页里的视频、音频和图片
• 点工具栏按钮，列出网页加载过的视频、音频、图片和 m3u8/DASH 播放列表，包括播放器在后台加载的
• 下载前可以预览，可以多选一起下载
• m3u8（HLS）和 DASH：选择清晰度，分片并行下载，AES-128 加密的分片自动解密，最后合并成一个文件
• 地址是 blob: 的视频可以录制下来，保存为 MP4

按你的习惯
• 自动接管超过指定大小的浏览器下载，也可以只下你发给它的
• 全局限速，设置同时下载的任务数
• 下载任务可搜索、按状态和类型筛选；完成的文件可直接打开、复制链接、重新下载
• 可选：下载完成或失败时弹出通知
• 直接保存到你选择的文件夹
• 批量下载网页上的所有链接，可以筛选和批量改名
• 支持中文和英文

隐私
没有账号，没有广告，不做跟踪。所有数据都留在你的浏览器里，扩展只连接你要下载的文件。

不支持：DRM 加密的视频、直播流和 YouTube。
```

## Privacy practices tab · 隐私权规范

**Single purpose:** Download files faster by splitting them into pieces downloaded over several connections, including the media files a page loads.

**Permission justifications** (paste one per field):

| Permission | Justification |
| --- | --- |
| downloads | Takes over downloads the user starts in the browser (above a size the user sets), and saves finished files into the user's download folder. |
| offscreen | The download engine runs in an offscreen document so downloads keep going while no extension page is open. |
| contextMenus | Adds "Download with Download Booster" to the right-click menu of links, videos, audio and images, and "Find downloadable links on this page". |
| storage | Keeps the user's settings and the list of media each open tab has loaded. |
| unlimitedStorage | Large files (several GB) are downloaded piece by piece into the extension's own storage before being saved, which needs more than the default quota. |
| declarativeNetRequestWithHostAccess | Sends the page's Referer with a download's requests, so files from sites that block requests without it (hotlink protection) still download. Applied only to the requests of the download the user started. |
| scripting | Reads the links on the current page when the user clicks "Find all links on this page", and, only while the user records a video, adds the recording script to that page. |
| webRequest | Sees which videos, audio, images and playlists a page loads, so the toolbar button can list them for the user to download. |
| notifications (optional) | Asked for only when the user turns on "Show a notification when a download finishes or fails" in the settings; shows that notification. |
| downloads.open (optional) | Asked for the first time the user clicks "Open" on a finished download; opens that file. |
| Host permission `<all_urls>` | Files can be on any website, and their pieces must be requested from that site with range requests; the media list needs to see what any page loads. |

**Remote code:** No, I am not using remote code. All code is in the package.

**Data usage:** the extension collects none of the listed data types. Tick the three certifications (no selling, no unrelated use, no creditworthiness use).

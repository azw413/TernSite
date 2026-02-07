#[macro_use]
extern crate rocket;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rocket::fs::{relative, FileServer, TempFile};
use rocket::http::{ContentType, Header, Status};
use rocket::response::{Responder, Response};
use rocket::serde::json::Json;
use rocket::tokio::io::AsyncReadExt;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use std::io::Cursor;

use tern_book::{convert_epub_to_trbk_multi, FontPaths};
use tern_image::{convert_bytes, write_trimg, ConvertOptions, DitherMode, FitMode, RegionMode};

#[derive(Serialize)]
struct InfoResponse {
    name: &'static str,
    version: &'static str,
    device: &'static str,
    firmware_images: &'static [&'static str],
}

#[derive(Serialize)]
struct FirmwareLatestResponse {
    tag: String,
    asset_name: String,
    size: u64,
    download_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct CachedFirmware {
    tag: String,
    asset_name: String,
    size: u64,
    downloaded_at: u64,
    file_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct CachedRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
    fetched_at: u64,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Clone, Deserialize, Serialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

struct BinaryFile {
    data: Vec<u8>,
    content_type: ContentType,
    headers: rocket::http::Header<'static>,
}

impl<'r> Responder<'r, 'static> for BinaryFile {
    fn respond_to(self, _req: &'r rocket::Request<'_>) -> rocket::response::Result<'static> {
        Response::build()
            .header(self.content_type)
            .header(self.headers)
            .sized_body(self.data.len(), Cursor::new(self.data))
            .ok()
    }
}

#[derive(FromForm)]
struct ImageForm<'r> {
    file: TempFile<'r>,
    #[field(default = "auto")]
    region: String,
    #[field(default = "width")]
    fit: String,
    #[field(default = "bayer")]
    dither: String,
    #[field(default = false)]
    invert: bool,
    #[field(default = 2)]
    trimg_version: u8,
    output_name: Option<String>,
}

#[derive(FromForm)]
struct BookForm<'r> {
    file: TempFile<'r>,
    #[field(default = "24")]
    sizes: String,
    #[field(default = "bookerly")]
    font: String,
    output_name: Option<String>,
}

fn parse_fit(value: &str) -> FitMode {
    match value.to_lowercase().as_str() {
        "contain" => FitMode::Contain,
        "cover" => FitMode::Cover,
        "stretch" => FitMode::Stretch,
        "integer" => FitMode::Integer,
        _ => FitMode::Width,
    }
}

fn parse_dither(value: &str) -> DitherMode {
    match value.to_lowercase().as_str() {
        "none" => DitherMode::None,
        _ => DitherMode::Bayer,
    }
}

fn parse_region(value: &str) -> RegionMode {
    match value.to_lowercase().as_str() {
        "none" => RegionMode::None,
        "crisp" => RegionMode::Crisp,
        "barcode" => RegionMode::Barcode,
        _ => RegionMode::Auto,
    }
}

fn parse_sizes(value: &str) -> Vec<u16> {
    value
        .split(',')
        .filter_map(|s| s.trim().parse::<u16>().ok())
        .collect()
}

fn sanitize_filename(name: &str, fallback: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let sanitized: String = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '_' || *c == '-' || *c == ' ')
        .collect();
    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized.to_string()
    }
}

fn project_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn cache_dir() -> std::path::PathBuf {
    project_root().join("cache")
}

fn fonts_dir() -> std::path::PathBuf {
    project_root().join("fonts")
}

fn onnx_model_path() -> std::path::PathBuf {
    project_root().join("models/YOLOV8s_Barcode_Detection.onnx")
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_secs()
}

fn load_cached_release() -> Option<CachedRelease> {
    let path = cache_dir().join("latest_release.json");
    let data = std::fs::read(path).ok()?;
    serde_json::from_slice(&data).ok()
}

fn save_cached_release(release: &CachedRelease) {
    let path = cache_dir().join("latest_release.json");
    if std::fs::create_dir_all(cache_dir()).is_ok() {
        if let Ok(data) = serde_json::to_vec(release) {
            let _ = std::fs::write(path, data);
        }
    }
}

fn load_cached_firmware() -> Option<CachedFirmware> {
    let path = cache_dir().join("app_firmware.json");
    let data = std::fs::read(path).ok()?;
    serde_json::from_slice(&data).ok()
}

fn save_cached_firmware(fw: &CachedFirmware) {
    let path = cache_dir().join("app_firmware.json");
    if std::fs::create_dir_all(cache_dir()).is_ok() {
        if let Ok(data) = serde_json::to_vec(fw) {
            let _ = std::fs::write(path, data);
        }
    }
}

#[derive(Clone)]
struct LocalFirmware {
    tag: String,
    asset_name: String,
    size: u64,
    file_path: String,
}

fn discover_local_firmware() -> Option<LocalFirmware> {
    let entries = std::fs::read_dir(cache_dir()).ok()?;
    let mut best: Option<(LocalFirmware, SystemTime)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path.file_name()?.to_string_lossy().to_string();
        if !file_name.starts_with("tern-fw-") || !file_name.ends_with(".bin") {
            continue;
        }
        let tag = file_name
            .trim_start_matches("tern-fw-")
            .trim_end_matches(".bin")
            .to_string();
        let metadata = std::fs::metadata(&path).ok()?;
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let candidate = LocalFirmware {
            tag,
            asset_name: file_name,
            size: metadata.len(),
            file_path: path.to_string_lossy().to_string(),
        };
        match &best {
            Some((_, best_time)) if *best_time >= modified => {}
            _ => best = Some((candidate, modified)),
        }
    }
    best.map(|(fw, _)| fw)
}

fn select_app_asset(release: &GithubRelease) -> Option<GithubAsset> {
    release
        .assets
        .iter()
        .find(|asset| asset.name.starts_with("tern-fw-") && asset.name.ends_with(".bin"))
        .cloned()
}

fn resolve_font_paths(font_key: &str) -> Option<FontPaths> {
    match font_key.to_lowercase().as_str() {
        "bookerly" => {
            let base = fonts_dir();
            let regular = base.join("Bookerly.ttf");
            let bold = base.join("Bookerly Bold.ttf");
            let italic = base.join("Bookerly Italic.ttf");
            let bold_italic = base.join("Bookerly Bold Italic.ttf");
            if !regular.exists() {
                return None;
            }
            Some(FontPaths {
                regular: Some(regular.to_string_lossy().to_string()),
                bold: bold.exists().then(|| bold.to_string_lossy().to_string()),
                italic: italic.exists().then(|| italic.to_string_lossy().to_string()),
                bold_italic: bold_italic.exists().then(|| bold_italic.to_string_lossy().to_string()),
            })
        }
        _ => None,
    }
}

async fn fetch_latest_release() -> Result<GithubRelease, Status> {
    if let Some(cached) = load_cached_release() {
        let age = now_epoch().saturating_sub(cached.fetched_at);
        if age < 600 {
            return Ok(GithubRelease {
                tag_name: cached.tag_name,
                assets: cached.assets,
            });
        }
    }

    let client = reqwest::Client::new();
    let response = client
        .get("https://api.github.com/repos/azw413/TernReader/releases/latest")
        .header("User-Agent", "tern-site")
        .send()
        .await
        .map_err(|_| Status::BadGateway)?;
    if !response.status().is_success() {
        return Err(Status::BadGateway);
    }
    let release = response
        .json::<GithubRelease>()
        .await
        .map_err(|_| Status::BadGateway)?;
    save_cached_release(&CachedRelease {
        tag_name: release.tag_name.clone(),
        assets: release.assets.clone(),
        fetched_at: now_epoch(),
    });
    Ok(release)
}

#[get("/api/info")]
fn info() -> Json<InfoResponse> {
    Json(InfoResponse {
        name: "TernReader Web Tools",
        version: "0.1.0",
        device: "Xteink X4 (ESP32-C3)",
        firmware_images: &["application", "full-merged"],
    })
}

#[get("/api/firmware/latest")]
async fn firmware_latest() -> Result<Json<FirmwareLatestResponse>, Status> {
    if let Some(local) = discover_local_firmware() {
        return Ok(Json(FirmwareLatestResponse {
            tag: local.tag,
            asset_name: local.asset_name,
            size: local.size,
            download_path: "/api/firmware/app".to_string(),
        }));
    }
    let release = fetch_latest_release().await?;
    let asset = select_app_asset(&release).ok_or(Status::NotFound)?;
    Ok(Json(FirmwareLatestResponse {
        tag: release.tag_name,
        asset_name: asset.name,
        size: asset.size,
        download_path: "/api/firmware/app".to_string(),
    }))
}

#[get("/api/firmware/app")]
async fn firmware_app() -> Result<BinaryFile, Status> {
    if let Some(local) = discover_local_firmware() {
        if let Ok(data) = std::fs::read(&local.file_path) {
            return Ok(BinaryFile {
                data,
                content_type: ContentType::Binary,
                headers: Header::new(
                    "Content-Disposition",
                    format!("attachment; filename={}", local.asset_name),
                ),
            });
        }
    }
    let release = fetch_latest_release().await?;
    let asset = select_app_asset(&release).ok_or(Status::NotFound)?;
    if let Some(cached) = load_cached_firmware() {
        if cached.tag == release.tag_name && cached.asset_name == asset.name {
            if let Ok(data) = std::fs::read(&cached.file_path) {
                return Ok(BinaryFile {
                    data,
                    content_type: ContentType::Binary,
                    headers: Header::new(
                        "Content-Disposition",
                        format!("attachment; filename={}", asset.name),
                    ),
                });
            }
        }
    }

    let data = reqwest::get(&asset.browser_download_url)
        .await
        .map_err(|_| Status::BadGateway)?
        .bytes()
        .await
        .map_err(|_| Status::BadGateway)?;

    let file_path = cache_dir().join(&asset.name);
    if std::fs::create_dir_all(cache_dir()).is_ok() {
        let _ = std::fs::write(&file_path, &data);
        save_cached_firmware(&CachedFirmware {
            tag: release.tag_name.clone(),
            asset_name: asset.name.clone(),
            size: asset.size,
            downloaded_at: now_epoch(),
            file_path: file_path.to_string_lossy().to_string(),
        });
    }

    Ok(BinaryFile {
        data: data.to_vec(),
        content_type: ContentType::Binary,
        headers: Header::new(
            "Content-Disposition",
            format!("attachment; filename={}", asset.name),
        ),
    })
}

#[post("/api/convert/image", data = "<form>")]
async fn convert_image(form: rocket::form::Form<ImageForm<'_>>) -> Result<BinaryFile, Status> {
    let mut bytes = Vec::new();
    let mut reader = form
        .file
        .open()
        .await
        .map_err(|_| Status::BadRequest)?;
    reader
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Status::BadRequest)?;

    let mut options = ConvertOptions::default();
    options.fit = parse_fit(&form.fit);
    options.dither = parse_dither(&form.dither);
    options.region_mode = parse_region(&form.region);
    options.invert = form.invert;
    options.trimg_version = if form.trimg_version == 2 { 2 } else { 1 };
    let onnx_path = onnx_model_path();
    if onnx_path.exists() {
        options.yolo_model = Some(onnx_path);
    }

    let trimg = convert_bytes(&bytes, options).map_err(|_| Status::BadRequest)?;

    let tmp = NamedTempFile::new().map_err(|_| Status::InternalServerError)?;
    write_trimg(tmp.path(), &trimg).map_err(|_| Status::InternalServerError)?;
    let data = std::fs::read(tmp.path()).map_err(|_| Status::InternalServerError)?;

    let filename = form
        .output_name
        .as_deref()
        .map(|name| sanitize_filename(name, "converted.tri"))
        .unwrap_or_else(|| "converted.tri".to_string());

    Ok(BinaryFile {
        data,
        content_type: ContentType::Binary,
        headers: Header::new(
            "Content-Disposition",
            format!("attachment; filename={}", filename),
        ),
    })
}

#[post("/api/convert/book", data = "<form>")]
async fn convert_book(form: rocket::form::Form<BookForm<'_>>) -> Result<BinaryFile, Status> {
    let mut epub_bytes = Vec::new();
    let mut reader = form
        .file
        .open()
        .await
        .map_err(|_| Status::BadRequest)?;
    reader
        .read_to_end(&mut epub_bytes)
        .await
        .map_err(|_| Status::BadRequest)?;

    let epub_tmp = NamedTempFile::new().map_err(|_| Status::InternalServerError)?;
    std::fs::write(epub_tmp.path(), &epub_bytes).map_err(|_| Status::InternalServerError)?;

    let sizes = parse_sizes(&form.sizes);
    let sizes = if sizes.is_empty() { vec![18] } else { sizes };

    let font_paths = resolve_font_paths(&form.font).ok_or(Status::BadRequest)?;

    let out_tmp = NamedTempFile::new().map_err(|_| Status::InternalServerError)?;
    convert_epub_to_trbk_multi(epub_tmp.path(), out_tmp.path(), &sizes, &font_paths)
        .map_err(|_| Status::InternalServerError)?;

    let data = std::fs::read(out_tmp.path()).map_err(|_| Status::InternalServerError)?;

    let filename = form
        .output_name
        .as_deref()
        .map(|name| sanitize_filename(name, "converted.trbk"))
        .unwrap_or_else(|| "converted.trbk".to_string());

    Ok(BinaryFile {
        data,
        content_type: ContentType::Binary,
        headers: Header::new(
            "Content-Disposition",
            format!("attachment; filename={}", filename),
        ),
    })
}

#[launch]
fn rocket() -> _ {
    rocket::build()
        .mount("/", FileServer::from(relative!("static")))
        .mount(
            "/",
            routes![info, firmware_latest, firmware_app, convert_image, convert_book],
        )
}

use crate::{
    commands,
    error::{Error, Result},
    workspace::AppState,
};
use std::{fs, path::Path};
use tauri::State;
use windows::{
    core::HSTRING,
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapEncoder, BitmapInterpolationMode, BitmapPixelFormat,
        BitmapTransform, ColorManagementMode, ExifOrientationMode,
    },
    Storage::{FileAccessMode, StorageFile},
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

fn encode(src: &Path, dest: &Path) -> windows::core::Result<()> {
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(src.as_os_str()))?.join()?;
    let stream = file.OpenAsync(FileAccessMode::Read)?.join()?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
    let (w, h) = (
        decoder.OrientedPixelWidth()?,
        decoder.OrientedPixelHeight()?,
    );
    let scale = (512.0 / w.max(h).max(1) as f64).min(1.0);
    let transform = BitmapTransform::new()?;
    transform.SetScaledWidth(((w as f64 * scale) as u32).max(1))?;
    transform.SetScaledHeight(((h as f64 * scale) as u32).max(1))?;
    transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .join()?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(dest.as_os_str()))?.join()?;
    let out = file.OpenAsync(FileAccessMode::ReadWrite)?.join()?;
    let encoder = BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId()?, &out)?.join()?;
    encoder.SetSoftwareBitmap(&bitmap)?;
    encoder.FlushAsync()?.join()?;
    out.FlushAsync()?.join()?;
    Ok(())
}

#[tauri::command]
pub async fn thumbnail_asset(state: State<'_, AppState>, id: String) -> Result<String> {
    let (root, src, key) = state.with(|ws| {
        let asset =
            commands::get_asset(&ws.conn, "id", &id)?.ok_or_else(|| Error::NotFound("资源", id))?;
        Ok((
            ws.root.clone(),
            ws.abs(&asset.path),
            asset.hash.split(':').next().unwrap_or_default().to_string(),
        ))
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let rel = format!(".lattira/thumbnails/{key}.png");
        let dest = root.join(&rel);
        if dest.is_file() {
            return Ok(rel);
        }
        fs::create_dir_all(dest.parent().unwrap())?;
        let tmp = dest.with_extension(format!("{}.tmp", crate::workspace::new_id()));
        fs::File::create(&tmp)?;
        let initialized = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.is_ok();
        let result = encode(&src, &tmp);
        if initialized {
            unsafe { RoUninitialize() };
        }
        if let Err(e) = result {
            let _ = fs::remove_file(&tmp);
            return Err(Error::Invalid(e.to_string()));
        }
        crate::files::sync_file(&tmp)?;
        fs::rename(&tmp, &dest)?;
        Ok(rel)
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_decoder_generates_cached_png() {
        let dir =
            std::env::temp_dir().join(format!("lattira-thumbnail-{}", crate::workspace::new_id()));
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("image.gif");
        let dest = dir.join("thumbnail.png");
        fs::write(
            &src,
            [
                71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4,
                1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
            ],
        )
        .unwrap();
        fs::File::create(&dest).unwrap();
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED).unwrap();
        }
        let result = encode(&src, &dest);
        unsafe {
            RoUninitialize();
        }
        result.unwrap();
        let size = imagesize::size(&dest).unwrap();
        assert_eq!((size.width, size.height), (1, 1));
        fs::remove_dir_all(dir).unwrap();
    }
}

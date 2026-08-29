//! Captura rapida de miniatura para o seletor de compartilhamento de tela.

use image::{ColorType, codecs::jpeg::JpegEncoder};

// Definicoes de FFI do Win32 para nao depender de crates pesadas
type HWND = *mut std::ffi::c_void;
type HDC = *mut std::ffi::c_void;
type HBITMAP = *mut std::ffi::c_void;
type HGDIOBJ = *mut std::ffi::c_void;
type BOOL = i32;

#[repr(C)]
#[derive(Default)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct BITMAPINFOHEADER {
    bi_size: u32,
    bi_width: i32,
    bi_height: i32,
    bi_planes: u16,
    bi_bit_count: u16,
    bi_compression: u32,
    bi_size_image: u32,
    bi_x_pels_per_meter: i32,
    bi_y_pels_per_meter: i32,
    bi_clr_used: u32,
    bi_clr_important: u32,
}

#[repr(C)]
struct BITMAPINFO {
    bmi_header: BITMAPINFOHEADER,
    bmi_colors: [u32; 1],
}

#[repr(C)]
struct MONITORINFO {
    cb_size: u32,
    rc_monitor: RECT,
    rc_work: RECT,
    dw_flags: u32,
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetDC(hwnd: HWND) -> HDC;
    fn ReleaseDC(hwnd: HWND, hdc: HDC) -> i32;
    fn GetWindowRect(hwnd: HWND, rect: *mut RECT) -> BOOL;
    fn PrintWindow(hwnd: HWND, hdc_dest: HDC, n_flags: u32) -> BOOL;
    fn GetMonitorInfoW(hmonitor: *mut std::ffi::c_void, lpmi: *mut MONITORINFO) -> BOOL;
}

#[link(name = "gdi32")]
unsafe extern "system" {
    fn CreateCompatibleDC(hdc: HDC) -> HDC;
    fn DeleteDC(hdc: HDC) -> BOOL;
    fn CreateCompatibleBitmap(hdc: HDC, cx: i32, cy: i32) -> HBITMAP;
    fn SelectObject(hdc: HDC, h: HGDIOBJ) -> HGDIOBJ;
    fn DeleteObject(ho: HGDIOBJ) -> BOOL;
    fn SetStretchBltMode(hdc: HDC, mode: i32) -> i32;
    fn StretchBlt(
        hdc_dest: HDC, x_dest: i32, y_dest: i32, w_dest: i32, h_dest: i32,
        hdc_src: HDC, x_src: i32, y_src: i32, w_src: i32, h_src: i32, rop: u32,
    ) -> BOOL;
    fn BitBlt(
        hdc_dest: HDC, x_dest: i32, y_dest: i32, w_dest: i32, h_dest: i32,
        hdc_src: HDC, x_src: i32, y_src: i32, rop: u32,
    ) -> BOOL;
    fn GetDIBits(
        hdc: HDC, hbm: HBITMAP, start: u32, lines: u32,
        lpv_bits: *mut std::ffi::c_void, lpbmi: *mut BITMAPINFO, usage: u32,
    ) -> i32;
}

const SRCCOPY: u32 = 0x00CC0020;
const HALFTONE: i32 = 4;
const PW_RENDERFULLCONTENT: u32 = 2;
const BI_RGB: u32 = 0;
const DIB_RGB_COLORS: u32 = 0;

pub fn capture_thumbnail(target: super::sources::Target) -> Result<String, String> {
    match target {
        super::sources::Target::Window(hwnd_val) => capture_window_thumb(hwnd_val as HWND),
        super::sources::Target::Monitor(hmon_val) => capture_monitor_thumb(hmon_val as *mut _),
    }
}

fn capture_window_thumb(hwnd: HWND) -> Result<String, String> {
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err("Nao foi possivel obter dimensoes da janela".into());
    }
    let src_w = (rect.right - rect.left).max(1);
    let src_h = (rect.bottom - rect.top).max(1);

    let thumb_w = 320i32;
    let thumb_h = ((src_h as f32 / src_w as f32) * thumb_w as f32).max(1.0) as i32;

    let screen_dc = unsafe { GetDC(std::ptr::null_mut()) };
    if screen_dc.is_null() { return Err("Falha GetDC".into()); }
    
    let mem_dc = unsafe { CreateCompatibleDC(screen_dc) };
    let full_bmp = unsafe { CreateCompatibleBitmap(screen_dc, src_w, src_h) };
    let old_full = unsafe { SelectObject(mem_dc, full_bmp as HGDIOBJ) };

    let printed = unsafe { PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT) != 0 || PrintWindow(hwnd, mem_dc, 0) != 0 };
    if !printed {
        unsafe { BitBlt(mem_dc, 0, 0, src_w, src_h, screen_dc, rect.left, rect.top, SRCCOPY); }
    }

    let thumb_dc = unsafe { CreateCompatibleDC(screen_dc) };
    let thumb_bmp = unsafe { CreateCompatibleBitmap(screen_dc, thumb_w, thumb_h) };
    let old_thumb = unsafe { SelectObject(thumb_dc, thumb_bmp as HGDIOBJ) };

    unsafe {
        SetStretchBltMode(thumb_dc, HALFTONE);
        StretchBlt(thumb_dc, 0, 0, thumb_w, thumb_h, mem_dc, 0, 0, src_w, src_h, SRCCOPY);
    }

    let pixels = get_bitmap_rgb(thumb_dc, thumb_bmp, thumb_w as u32, thumb_h as u32)?;

    unsafe {
        SelectObject(thumb_dc, old_thumb);
        DeleteObject(thumb_bmp as HGDIOBJ);
        DeleteDC(thumb_dc);

        SelectObject(mem_dc, old_full);
        DeleteObject(full_bmp as HGDIOBJ);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
    }

    encode_jpeg_base64(&pixels, thumb_w as u32, thumb_h as u32)
}

fn capture_monitor_thumb(hmon: *mut std::ffi::c_void) -> Result<String, String> {
    let mut mi = MONITORINFO {
        cb_size: std::mem::size_of::<MONITORINFO>() as u32,
        rc_monitor: RECT::default(),
        rc_work: RECT::default(),
        dw_flags: 0,
    };
    if unsafe { GetMonitorInfoW(hmon, &mut mi) } == 0 {
        return Err("Nao foi possivel obter info do monitor".into());
    }

    let src_w = (mi.rc_monitor.right - mi.rc_monitor.left).max(1);
    let src_h = (mi.rc_monitor.bottom - mi.rc_monitor.top).max(1);

    let thumb_w = 320i32;
    let thumb_h = ((src_h as f32 / src_w as f32) * thumb_w as f32).max(1.0) as i32;

    let screen_dc = unsafe { GetDC(std::ptr::null_mut()) };
    if screen_dc.is_null() { return Err("Falha GetDC".into()); }

    let thumb_dc = unsafe { CreateCompatibleDC(screen_dc) };
    let thumb_bmp = unsafe { CreateCompatibleBitmap(screen_dc, thumb_w, thumb_h) };
    let old_thumb = unsafe { SelectObject(thumb_dc, thumb_bmp as HGDIOBJ) };

    unsafe {
        SetStretchBltMode(thumb_dc, HALFTONE);
        StretchBlt(
            thumb_dc, 0, 0, thumb_w, thumb_h,
            screen_dc, mi.rc_monitor.left, mi.rc_monitor.top, src_w, src_h,
            SRCCOPY,
        );
    }

    let pixels = get_bitmap_rgb(thumb_dc, thumb_bmp, thumb_w as u32, thumb_h as u32)?;

    unsafe {
        SelectObject(thumb_dc, old_thumb);
        DeleteObject(thumb_bmp as HGDIOBJ);
        DeleteDC(thumb_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
    }

    encode_jpeg_base64(&pixels, thumb_w as u32, thumb_h as u32)
}

fn get_bitmap_rgb(hdc: HDC, hbm: HBITMAP, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut bmi = BITMAPINFO {
        bmi_header: BITMAPINFOHEADER {
            bi_size: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            bi_width: width as i32,
            bi_height: -(height as i32), // Top-down
            bi_planes: 1,
            bi_bit_count: 32,
            bi_compression: BI_RGB,
            bi_size_image: 0,
            bi_x_pels_per_meter: 0,
            bi_y_pels_per_meter: 0,
            bi_clr_used: 0,
            bi_clr_important: 0,
        },
        bmi_colors: [0],
    };

    let count = (width * height) as usize;
    let mut bgra_buf: Vec<u8> = vec![0; count * 4];

    let lines = unsafe {
        GetDIBits(
            hdc,
            hbm,
            0,
            height,
            bgra_buf.as_mut_ptr() as *mut _,
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };

    if lines <= 0 {
        return Err("Falha GetDIBits".into());
    }

    let mut rgb_buf = Vec::with_capacity(count * 3);
    for chunk in bgra_buf.chunks_exact(4) {
        rgb_buf.push(chunk[2]); // R
        rgb_buf.push(chunk[1]); // G
        rgb_buf.push(chunk[0]); // B
    }

    Ok(rgb_buf)
}

fn encode_jpeg_base64(rgb: &[u8], width: u32, height: u32) -> Result<String, String> {
    let mut jpeg_bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 75);
    encoder
        .encode(rgb, width, height, ColorType::Rgb8.into())
        .map_err(|e| format!("Falha encoding JPEG: {e}"))?;

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);
    Ok(format!("data:image/jpeg;base64,{b64}"))
}

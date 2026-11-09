//! macOS Vision OCR (VNRecognizeTextRequest). Much faster than Tesseract on Apple silicon and better on
//! photos / complex layouts. Returns word boxes in normalized image coordinates (origin top-left).
use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct VisionWord {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub text: String,
    pub confidence: f32,
}

/// Vision reports one box per line. Split it into words proportionally to character offsets, converting
/// from Vision's bottom-left-origin normalized rect to top-left-origin.
pub fn split_line(text: &str, x: f64, y: f64, w: f64, h: f64, confidence: f32) -> Vec<VisionWord> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len().max(1) as f64;
    let top = 1.0 - (y + h);
    let mut out = vec![];
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() { i += 1; continue; }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() { i += 1; }
        let word: String = chars[start..i].iter().collect();
        out.push(VisionWord { x0: x + w * start as f64 / n, x1: x + w * i as f64 / n, y0: top, y1: top + h, text: word, confidence });
    }
    out
}

#[cfg(target_os = "macos")]
pub fn recognize(png: &[u8], languages: &[String], fast: bool) -> Result<Vec<VisionWord>, String> {
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

    objc2::rc::autoreleasepool(|_| {
        let data = NSData::with_bytes(png);
        let handler = VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), &data, &NSDictionary::new());
        let req = VNRecognizeTextRequest::new();
        req.setRecognitionLevel(if fast { VNRequestTextRecognitionLevel::Fast } else { VNRequestTextRecognitionLevel::Accurate });
        req.setUsesLanguageCorrection(true);
        if !languages.is_empty() {
            let langs: Vec<Retained<NSString>> = languages.iter().map(|l| NSString::from_str(l)).collect();
            req.setRecognitionLanguages(&NSArray::from_retained_slice(&langs));
        }
        let as_request: &VNRequest = &req;
        let requests = NSArray::from_slice(&[as_request]);
        handler.performRequests_error(&requests).map_err(|e| e.localizedDescription().to_string())?;
        let mut words = vec![];
        if let Some(results) = req.results() {
            for obs in results.iter() {
                let cands = obs.topCandidates(1);
                let Some(best) = cands.firstObject() else { continue };
                let text = best.string().to_string();
                let r = unsafe { obs.boundingBox() };
                let conf = unsafe { best.confidence() };
                words.extend(split_line(&text, r.origin.x, r.origin.y, r.size.width, r.size.height, conf));
            }
        }
        Ok(words)
    })
}

#[cfg(target_os = "macos")]
pub fn languages() -> Vec<String> {
    use objc2_vision::VNRecognizeTextRequest;
    let req = VNRecognizeTextRequest::new();
    unsafe { req.supportedRecognitionLanguagesAndReturnError() }.map(|a| a.iter().map(|s| s.to_string()).collect()).unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
pub fn recognize(_png: &[u8], _languages: &[String], _fast: bool) -> Result<Vec<VisionWord>, String> { Err("Vision OCR is only available on macOS".into()) }
#[cfg(not(target_os = "macos"))]
pub fn languages() -> Vec<String> { vec![] }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_split_and_flip() {
        let w = split_line("Hello big world", 0.1, 0.8, 0.6, 0.05, 0.9);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].text, "Hello");
        assert!((w[0].x0 - 0.1).abs() < 1e-9);
        assert!((w[0].y0 - 0.15).abs() < 1e-9, "top-left origin");
        assert!((w[2].x1 - 0.7).abs() < 1e-9);
    }

    /// Recognize a real image: `LOCAL_LIB_OCR_PNG=/path/page.png cargo test live_vision -- --ignored --nocapture`
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn live_vision() {
        let path = std::env::var("LOCAL_LIB_OCR_PNG").expect("set LOCAL_LIB_OCR_PNG");
        let png = std::fs::read(path).unwrap();
        let t = std::time::Instant::now();
        let words = recognize(&png, &["en-US".into()], false).unwrap();
        println!("Vision: {} words in {:?}: {}", words.len(), t.elapsed(), words.iter().take(12).map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "));
        assert!(!words.is_empty());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn vision_languages() {
        let langs = languages();
        println!("Vision OCR languages: {}", langs.len());
        assert!(langs.iter().any(|l| l.starts_with("en")));
    }
}

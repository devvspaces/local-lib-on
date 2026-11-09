use std::path::Path;

/// Formats the reader can open. PDF goes through pdf.js, everything else through foliate-js.
pub const SUPPORTED: &[(&str, &str)] = &[
    ("pdf", "pdf"),
    ("epub", "epub"),
    ("mobi", "mobi"),
    ("azw", "mobi"),
    ("azw3", "azw3"),
    ("kf8", "azw3"),
    ("fb2", "fb2"),
    ("fbz", "fb2"),
    ("cbz", "cbz"),
    ("txt", "txt"),
    ("djvu", "djvu"),
    ("djv", "djvu"),
    ("docx", "docx"),
    ("odt", "odt"),
    ("md", "md"),
];

pub fn format_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    // "book.fb2.zip"
    if ext == "zip" {
        let stem = path.file_stem()?.to_str()?.to_ascii_lowercase();
        if stem.ends_with(".fb2") {
            return Some("fb2");
        }
        return None;
    }
    SUPPORTED.iter().find(|(e, _)| *e == ext).map(|(_, f)| *f)
}

#[derive(Debug, Default, PartialEq)]
pub struct FilenameMeta {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
}

/// Best-effort metadata from common file naming schemes:
///   "Author - Title (2019).pdf", "Title by Author.epub", "Title_2nd_Edition.pdf"
/// Real metadata is filled in later by the frontend enrichment pass (pdf.js / foliate-js).
pub fn guess_from_filename(path: &Path) -> FilenameMeta {
    let raw = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .trim_end_matches(".fb2");
    let mut s = raw.replace('_', " ");
    let year_re = regex::Regex::new(r"[\(\[]((?:19|20)\d{2})[\)\]]").unwrap();
    let mut year = None;
    if let Some(c) = year_re.captures(&s) {
        year = c[1].parse().ok();
        s = year_re.replace(&s, "").to_string();
    }
    // strip trailing bracketed noise like "[ebook]" or "(z-lib.org)"
    let noise_re = regex::Regex::new(r"\s*[\(\[][^\)\]]*[\)\]]\s*$").unwrap();
    while noise_re.is_match(&s) {
        s = noise_re.replace(&s, "").to_string();
    }
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");

    if let Some((a, t)) = s.split_once(" - ") {
        let authors: Vec<String> = a
            .split(&[',', '&', ';'][..])
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect();
        if !authors.is_empty() && authors.iter().all(|x| x.split_whitespace().count() <= 4) {
            return FilenameMeta { title: t.trim().to_string(), authors, year };
        }
    }
    if let Some((t, a)) = s.rsplit_once(" by ") {
        if a.split_whitespace().count() <= 4 {
            return FilenameMeta { title: t.trim().to_string(), authors: vec![a.trim().to_string()], year };
        }
    }
    FilenameMeta { title: if s.is_empty() { "Untitled".into() } else { s }, authors: vec![], year }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn formats() {
        assert_eq!(format_for(Path::new("a/B.PDF")), Some("pdf"));
        assert_eq!(format_for(Path::new("x.fb2.zip")), Some("fb2"));
        assert_eq!(format_for(Path::new("x.zip")), None);
        assert_eq!(format_for(Path::new("x.docx")), Some("docx"));
        assert_eq!(format_for(Path::new("x.doc")), None);
    }

    #[test]
    fn filename_guessing() {
        let m = guess_from_filename(&PathBuf::from("Martin Kleppmann - Designing Data-Intensive Applications (2017).pdf"));
        assert_eq!(m.title, "Designing Data-Intensive Applications");
        assert_eq!(m.authors, vec!["Martin Kleppmann"]);
        assert_eq!(m.year, Some(2017));

        let m = guess_from_filename(&PathBuf::from("Clean_Code_by_Robert_Martin.epub"));
        assert_eq!(m.title, "Clean Code");
        assert_eq!(m.authors, vec!["Robert Martin"]);

        let m = guess_from_filename(&PathBuf::from("lecture-notes.pdf"));
        assert_eq!(m.title, "lecture-notes");
        assert!(m.authors.is_empty());
    }
}

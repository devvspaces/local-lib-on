use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Book {
    pub id: i64,
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub doi: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
    pub edition: Option<String>,
    pub place: Option<String>,
    pub num_pages: Option<i64>,
    pub item_type: String,
    pub short_title: Option<String>,
    pub metadata_source: Option<String>,
    pub cover_path: Option<String>,
    pub rating: Option<i64>,
    pub status: String,
    pub favorite: bool,
    pub added_at: String,
    pub last_opened_at: Option<String>,
    pub percent: f64,
    pub files: Vec<BookFile>,
    pub tags: Vec<Tag>,
    pub collection_ids: Vec<i64>,
    pub identifiers: Vec<Identifier>,
    pub enriched: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookFile {
    pub id: i64,
    pub path: String,
    pub format: String,
    pub size: i64,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Identifier {
    pub scheme: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSearch {
    pub id: i64,
    pub name: String,
    pub filter: LibraryFilter,
}

/// Library filter used by the library view and by saved searches (smart collections).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct LibraryFilter {
    pub text: Option<String>,
    pub collection_id: Option<i64>,
    pub tag_ids: Vec<i64>,
    pub formats: Vec<String>,
    pub status: Option<String>,
    pub favorite: Option<bool>,
    pub author: Option<String>,
    pub missing: Option<bool>,
    pub sort: Option<String>, // added | title | author | year | opened | progress
    pub desc: Option<bool>,
}

/// Partial update sent by the metadata editor and by the reader enrichment pass.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BookPatch {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub authors: Option<Vec<String>>,
    pub year: Option<i64>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub doi: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub description: Option<String>,
    pub edition: Option<String>,
    pub place: Option<String>,
    pub num_pages: Option<i64>,
    pub item_type: Option<String>,
    pub short_title: Option<String>,
    pub metadata_source: Option<String>,
    /// Extra ISBNs (print / ebook editions) stored as identifiers.
    pub isbns: Option<Vec<String>>,
    pub rating: Option<i64>,
    pub status: Option<String>,
    pub favorite: Option<bool>,
    /// Only fill fields that are currently empty / filename-guessed (used by auto-enrichment).
    pub only_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScanReport {
    pub scanned: usize,
    pub added: usize,
    pub moved: usize,
    pub missing: usize,
    pub errors: Vec<String>,
}

-- Re-run enrichment with the round-2 pipeline for books that got no cover or junk metadata.
DELETE FROM kv WHERE key LIKE 'enriched:%' AND CAST(substr(key, 10) AS INTEGER) IN (
  SELECT id FROM books WHERE cover_path IS NULL OR authors LIKE '%Windows User%' OR authors = '[]'
);

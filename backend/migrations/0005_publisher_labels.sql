-- Preserve source ownership while using the same display aliases as the parser.
-- This corrects labels collected before canonicalPublisher was introduced.
UPDATE news SET publisher=CASE publisher
 WHEN 'Bloomberg.com' THEN 'Bloomberg'
 WHEN 'DW.com' THEN 'DW'
 WHEN 'Euronews.com' THEN 'Euronews'
 WHEN 'ABC News - Breaking News, Latest News and Videos' THEN 'ABC News'
 ELSE publisher END
WHERE publisher IN ('Bloomberg.com','DW.com','Euronews.com','ABC News - Breaking News, Latest News and Videos');
UPDATE news SET source_json=json_set(source_json,'$.publisher',publisher)
WHERE json_extract(source_json,'$.publisher')<>publisher;

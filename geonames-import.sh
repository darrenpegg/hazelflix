#!/bin/sh
# GeoNames' towns (https://www.geonames.org, CC BY 4.0: towns of 1,000 people or more, and the countries' names) made
# into the database reel finds a photo's place in, offline (decision 0067, docs/reel.md): geonames-import.sh FOLDER
#
# Fetched once (about 11 MB); the database is made beside the last one and moved over it when it's whole. Lines
# step=... say how far it's got; the files it unpacks are removed at the end.
set -eu

folder=$1
mkdir -p "$folder"
cd "$folder"
base=https://download.geonames.org/export/dump

say() {
    echo "step=$1"
}

say "fetching"
curl -sSfLR -o cities1000.zip.new "$base/cities1000.zip"
mv -f cities1000.zip.new cities1000.zip
curl -sSfLR -o countryInfo.txt.new "$base/countryInfo.txt"
mv -f countryInfo.txt.new countryInfo.txt

say "towns"
unzip -o -q cities1000.zip cities1000.txt
# name, country code, latitude, longitude; quotes dropped (sqlite's import reads them as quoting)
awk -F '\t' 'BEGIN { OFS = "\t" } { gsub(/"/, "", $2); print $2, $9, $5, $6 }' cities1000.txt > towns.tsv
grep -v '^#' countryInfo.txt | awk -F '\t' 'BEGIN { OFS = "\t" } { gsub(/"/, "", $5); print $1, $5 }' > countries.tsv

say "database"
rm -f places.db.new
sqlite3 places.db.new <<'SQL'
CREATE TABLE country (code TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE town_in (name TEXT, code TEXT, latitude REAL, longitude REAL);
.mode tabs
.import countries.tsv country
.import towns.tsv town_in
CREATE TABLE town (name TEXT NOT NULL, country TEXT NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL);
INSERT INTO town SELECT t.name, coalesce(c.name, t.code), t.latitude, t.longitude FROM town_in t LEFT JOIN country c ON c.code = t.code;
DROP TABLE town_in;
CREATE INDEX town_at ON town (latitude, longitude);
VACUUM;
SQL
mv -f places.db.new places.db
rm -f cities1000.txt towns.tsv countries.tsv
say "done"

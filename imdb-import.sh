#!/bin/sh
# IMDb's datasets (https://developer.imdb.com/non-commercial-datasets/, for personal and non-commercial use) made
# into reel's IMDb engine's database (decision 0057, docs/reel.md): imdb-import.sh FOLDER
#
# Each file is fetched when IMDb has a newer one (they're made daily). Only films (cinema, television and video: most
# sequels went straight to video; and shorts of 40 minutes or more, as IMDb calls Saludos Amigos) and series are kept (no adult titles), with their ratings, crew, principal people, those people's names and the titles they're known by
# elsewhere; the database is made beside the last one and moved over it when it's whole, so reel reads the old one
# meanwhile. Lines step=... say how far it's got (reel shows them); the files it unpacks are removed at the end.
set -eu

folder=$1
mkdir -p "$folder"
cd "$folder"
base=https://datasets.imdbws.com

say() {
    echo "step=$1"
}

# keep's rows: those whose first field is one of the ids in keep.txt
kept() {
    awk -F '\t' 'NR == FNR { keep[$1]; next } ($1 in keep)' keep.txt -
}

for f in title.basics title.ratings title.crew title.principals name.basics title.akas; do
    say "fetching $f"
    if [ -f "$f.tsv.gz" ]; then
        curl -sSfLR -z "$f.tsv.gz" -o "$f.tsv.gz.new" "$base/$f.tsv.gz"
    else
        curl -sSfLR -o "$f.tsv.gz.new" "$base/$f.tsv.gz"
    fi
    if [ -s "$f.tsv.gz.new" ]; then
        mv -f "$f.tsv.gz.new" "$f.tsv.gz"
    else
        rm -f "$f.tsv.gz.new"
    fi
done

say "titles"
gunzip -c title.basics.tsv.gz |
    awk -F '\t' 'NR > 1 && $5 == "0" && ($2 == "movie" || $2 == "tvMovie" || $2 == "video" || $2 == "tvSeries" || $2 == "tvMiniSeries" ||
                                    ($2 == "short" && $8 != "\\N" && $8 + 0 >= 40))' > titles.tsv
cut -f 1 titles.tsv > keep.txt

say "ratings"
gunzip -c title.ratings.tsv.gz | kept > ratings.tsv

say "crew"
gunzip -c title.crew.tsv.gz | kept > crew.tsv
# each director and writer of a title, a row each (crew lists them with commas): a person's films are found by them
awk -F '\t' '{ n = split($2, d, ","); for (i = 1; i <= n; i++) if (d[i] != "\\N" && d[i] != "") print $1 "\t" d[i] "\tdirector"
               n = split($3, w, ","); for (i = 1; i <= n; i++) if (w[i] != "\\N" && w[i] != "") print $1 "\t" w[i] "\twriter" }' \
    crew.tsv > crewpeople.tsv

say "people in them"
gunzip -c title.principals.tsv.gz | kept |
    awk -F '\t' '$4 == "actor" || $4 == "actress" || $4 == "self" || $4 == "director" || $4 == "writer" ||
                 $4 == "composer" || $4 == "cinematographer" || $4 == "producer"' > principals.tsv

say "names"
{
    cut -f 3 principals.tsv
    awk -F '\t' '{ n = split($2 "," $3, ids, ","); for (i = 1; i <= n; i++) if (ids[i] != "\\N" && ids[i] != "") print ids[i] }' crew.tsv
} | sort -u > people.txt
gunzip -c name.basics.tsv.gz | awk -F '\t' 'NR == FNR { keep[$1]; next } ($1 in keep)' people.txt - > names.tsv

say "other titles"
gunzip -c title.akas.tsv.gz | kept | awk -F '\t' '{ print $1 "\t" $3 }' | sort -u > akas.tsv

say "database"
for t in titles ratings crew crewpeople principals names akas; do
    tr '\t\n' '\037\036' < "$t.tsv" > "$t.a"
done
rm -f imdb.new.db
sqlite3 imdb.new.db <<'SQL'
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE title (id TEXT PRIMARY KEY, type TEXT, title TEXT, original TEXT, adult TEXT, year TEXT, ending TEXT,
                    runtime TEXT, genres TEXT);
CREATE TABLE rating (id TEXT PRIMARY KEY, value REAL, votes INTEGER);
CREATE TABLE crew (id TEXT PRIMARY KEY, directors TEXT, writers TEXT);
CREATE TABLE principal (id TEXT, ord INTEGER, person TEXT, category TEXT, job TEXT, characters TEXT);
CREATE TABLE crew_person (id TEXT, person TEXT, job TEXT);
CREATE TABLE person (id TEXT PRIMARY KEY, name TEXT, born TEXT, died TEXT, professions TEXT, known TEXT);
CREATE TABLE aka (id TEXT, title TEXT);
.mode ascii
.import titles.a title
.import ratings.a rating
.import crew.a crew
.import crewpeople.a crew_person
.import principals.a principal
.import names.a person
.import akas.a aka
CREATE INDEX principal_id ON principal (id);
-- a person's films (the person page), by the people in them and their directors and writers
CREATE INDEX principal_person ON principal (person);
CREATE INDEX crew_person_person ON crew_person (person);
CREATE INDEX crew_person_id ON crew_person (id);
-- every title a film's known by, its apostrophes taken out (Cuckoo's is cuckoos, as a file's name writes it)
CREATE VIRTUAL TABLE title_text USING fts5 (id UNINDEXED, title, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO title_text SELECT id, replace(replace(title, '''', ''), '’', '') FROM title;
INSERT INTO title_text SELECT id, replace(replace(original, '''', ''), '’', '') FROM title WHERE original != title;
INSERT INTO title_text SELECT a.id, replace(replace(a.title, '''', ''), '’', '') FROM aka a JOIN title t ON t.id = a.id
    WHERE a.title != t.title AND a.title != t.original;
DROP TABLE aka;
ANALYZE;
VACUUM;
SQL
mv -f imdb.new.db imdb.db
rm -f titles.tsv ratings.tsv crew.tsv crewpeople.tsv principals.tsv names.tsv akas.tsv ./*.a keep.txt people.txt
say "done"

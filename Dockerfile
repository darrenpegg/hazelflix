# HazelFlix in a container: Node.js, ffmpeg (x264 and x265: there's no VideoToolbox in Linux) and what the import
# scripts use (curl, sqlite, unzip, gawk). Alpine for its ffmpeg (8.1), which puts an iPhone's HEIC photos together
# from their tiles; Debian 13's (7.1) gives one 512 x 512 tile. README.md, "In Docker", says how to run it.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg sqlite curl unzip gawk

WORKDIR /app
COPY . .

# its data (the database, photos, converted copies): a volume, so a new image keeps it
ENV HAZELFLIX_DATA=/data
VOLUME /data
EXPOSE 8095

ENTRYPOINT ["./start.sh", "--web", "0.0.0.0:8095"]

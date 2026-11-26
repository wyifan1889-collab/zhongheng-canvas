"""Build an owned PCM fixture using Python's standard WAV writer, without dependencies."""

from hashlib import sha256
from math import pi, sin
from pathlib import Path
import json
import struct
import sys
import wave


fixture_path = Path(__file__).resolve().parent / "sine-24000-mono-s16.wav"
sample_rate = 24_000
frame_count = 240
pcm = struct.pack("<" + "h" * frame_count, *(
    round(8191 * sin(2 * pi * 440 * index / sample_rate))
    for index in range(frame_count)
))

with wave.open(str(fixture_path), "wb") as writer:
    writer.setnchannels(1)
    writer.setsampwidth(2)
    writer.setframerate(sample_rate)
    writer.writeframes(pcm)

print(json.dumps({
    "fixture": fixture_path.name,
    "generator": "Python standard-library wave + math + struct",
    "pythonVersion": sys.version.split()[0],
    "channels": 1,
    "sampleRate": sample_rate,
    "sampleWidthBytes": 2,
    "sampleFrames": frame_count,
    "frequencyHz": 440,
    "peakSampleValue": 8191,
    "sizeBytes": fixture_path.stat().st_size,
    "sha256": sha256(fixture_path.read_bytes()).hexdigest(),
    "scope": "Fixture construction values, not product limits or billable usage.",
}, indent=2))

"""Normalisation of quality, HDR/audio formats, languages and provider names."""

from __future__ import annotations

import re
import unicodedata

QUALITY_ORDER = {"SD": 1, "HD": 2, "FHD": 3, "QHD": 4, "UHD": 5}


def best_quality(*qs: str | None) -> str | None:
    qs = [q for q in qs if q in QUALITY_ORDER]
    return max(qs, key=QUALITY_ORDER.get) if qs else None


def quality_from_label(label: str | None) -> str | None:
    """JustWatch (SD/HD/_4K), Streaming Availability (sd/hd/qhd/uhd), Plex (sd/480/720/1080/4k)."""
    if not label:
        return None
    s = str(label).strip().lower().lstrip("_")
    if s in ("4k", "uhd", "2160", "2160p", "8k"):
        return "UHD"
    if s in ("qhd", "1440", "1440p"):
        return "QHD"
    if s in ("1080", "1080p", "fhd"):
        return "FHD"
    if s in ("hd", "720", "720p"):
        return "HD"
    if s in ("sd", "480", "576", "480p", "576p"):
        return "SD"
    return None


def quality_from_dims(width: int | None, height: int | None) -> str | None:
    w, h = width or 0, height or 0
    if not w and not h:
        return None
    if w >= 3200 or h >= 1800:
        return "UHD"
    if w >= 2200 or h >= 1300:
        return "QHD"
    if w >= 1800 or h >= 1000:
        return "FHD"
    if w >= 1200 or h >= 700:
        return "HD"
    return "SD"


# --- video / audio technology tags -------------------------------------
_VIDEO_PATTERNS = [
    ("DV", r"dolby\s*vision|\bdovi\b|\bdv\b|dolbyvision"),
    ("HDR10+", r"hdr\s*10\s*(\+|plus)"),
    ("HDR10", r"hdr\s*10(?!\s*(\+|plus))"),
    ("HLG", r"\bhlg\b|hyperloggamma|arib-std-b67"),
    ("HDR", r"\bhdr\b|smpte2084|\bpq\b"),
]
_AUDIO_PATTERNS = [
    ("Atmos", r"atmos"),
    ("DTS:X", r"dts[\s:-]*x\b|dtsx"),
    ("TrueHD", r"truehd"),
    ("DTS-HD MA", r"dts[\s-]*hd[\s-]*ma|\bdts-hd\b|\bma\b"),
    ("DTS", r"\bdts\b|\bdca\b"),
    ("DD+", r"\beac3\b|e-ac-3|dolby digital\s*\+|dolby digital plus|\bdd\+|\bddp\b"),
    ("DD", r"\bac3\b|\bac-3\b|dolby digital(?!\s*\+| plus)"),
    ("FLAC", r"\bflac\b"),
]
_VIDEO_CODECS = {"hevc": "HEVC", "h265": "HEVC", "h264": "H.264", "avc": "H.264", "av1": "AV1", "vp9": "VP9"}


def video_tags(*texts: str | None, codec: str | None = None) -> list[str]:
    blob = " ".join(t for t in texts if t).lower().replace("_", " ")
    tags = [tag for tag, pat in _VIDEO_PATTERNS if re.search(pat, blob)]
    # "HDR" is redundant once a concrete HDR format is known
    if "HDR" in tags and len(tags) > 1:
        tags.remove("HDR")
    c = _VIDEO_CODECS.get((codec or "").lower())
    if c:
        tags.append(c)
    return tags


def audio_tags(*texts: str | None, codec: str | None = None, channels: int | None = None) -> list[str]:
    blob = " ".join(t for t in [*texts, codec] if t).lower().replace("_", " ")
    tags = [tag for tag, pat in _AUDIO_PATTERNS if re.search(pat, blob)]
    for a, b in (("DTS-HD MA", "DTS"), ("DTS:X", "DTS"), ("DD+", "DD")):
        if a in tags and b in tags:
            tags.remove(b)
    if channels:
        tags.append({8: "7.1", 7: "6.1", 6: "5.1", 2: "2.0", 1: "1.0"}.get(channels, f"{channels}ch"))
    return tags


def justwatch_tech(values: list[str] | None, kind: str) -> list[str]:
    """JustWatch videoTechnology / audioTechnology enums, e.g. DOLBY_VISION, DOLBY_ATMOS."""
    out: list[str] = []
    for v in values or []:
        mapped = (video_tags(v) if kind == "video" else audio_tags(v))
        if not mapped:
            s = v.strip("_").upper()
            mapped = {"_5_POINT_1": "5.1", "5_POINT_1": "5.1", "_7_POINT_1": "7.1", "7_POINT_1": "7.1"}.get(
                v.upper(), [s.replace("_", " ").title()]
            )
            mapped = [mapped] if isinstance(mapped, str) else mapped
        out.extend(m for m in mapped if m not in out)
    return out


def merge_tags(*lists: list[str] | None) -> list[str]:
    out: list[str] = []
    for lst in lists:
        for t in lst or []:
            if t and t not in out:
                out.append(t)
    return out


# --- languages ---------------------------------------------------------
_LANG3 = {
    "cze": "cs", "ces": "cs", "slo": "sk", "slk": "sk", "eng": "en", "ger": "de", "deu": "de",
    "fre": "fr", "fra": "fr", "spa": "es", "ita": "it", "pol": "pl", "hun": "hu", "rus": "ru",
    "ukr": "uk", "jpn": "ja", "kor": "ko", "chi": "zh", "zho": "zh", "por": "pt", "dut": "nl",
    "nld": "nl", "swe": "sv", "nor": "no", "nob": "no", "dan": "da", "fin": "fi", "tur": "tr",
    "gre": "el", "ell": "el", "heb": "he", "ara": "ar", "hin": "hi", "tha": "th", "rum": "ro",
    "ron": "ro", "bul": "bg", "hrv": "hr", "srp": "sr", "slv": "sl", "vie": "vi", "ind": "id",
}


def lang(code: str | None) -> str | None:
    if not code:
        return None
    c = code.strip().lower().replace("_", "-").split("-")[0]
    if c in ("und", "zxx", "mis", "mul", ""):
        return None
    if len(c) == 3:
        return _LANG3.get(c, c)
    return c


def langs(codes) -> list[str]:
    out: list[str] = []
    for c in codes or []:
        l = lang(c)
        if l and l not in out:
            out.append(l)
    return out


# --- provider names ----------------------------------------------------
_PROVIDER_ALIASES = {
    "max": "hbomax", "hbo": "hbomax", "hbomax": "hbomax",
    "disney": "disneyplus", "disneyplus": "disneyplus", "dnp": "disneyplus",
    "netflix": "netflix", "nfx": "netflix",
    "prime": "primevideo", "primevideo": "primevideo", "amazonprimevideo": "primevideo", "amazonprime": "primevideo",
    "apple": "appletv", "appletv": "appletv", "appletvplus": "appletv", "atp": "appletv",
    "skyshowtime": "skyshowtime", "oneplay": "oneplay",
    "paramount": "paramountplus", "paramountplus": "paramountplus",
}


def provider_key(name_or_id: str) -> str:
    s = re.sub(r"[^a-z0-9]", "", strip_accents(name_or_id or "").lower())
    return _PROVIDER_ALIASES.get(s, s)


# --- text --------------------------------------------------------------
def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm(s: str | None) -> str:
    if not s:
        return ""
    s = strip_accents(s).lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()

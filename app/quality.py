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
_LANG3 = {"afr": "af", "alb": "sq", "amh": "am", "ara": "ar", "arm": "hy", "aze": "az", "baq": "eu", "bel": "be", "ben": "bn", "bos": "bs", "bul": "bg", "bur": "my", "cat": "ca", "ces": "cs", "chi": "zh", "cmn": "zh", "cym": "cy", "cze": "cs", "dan": "da", "deu": "de", "dut": "nl", "ell": "el", "eng": "en", "est": "et", "eus": "eu", "fao": "fo", "fas": "fa", "fil": "tl", "fin": "fi", "fra": "fr", "fre": "fr", "geo": "ka", "ger": "de", "gla": "gd", "gle": "ga", "glg": "gl", "gre": "el", "gsw": "de", "guj": "gu", "heb": "he", "hin": "hi", "hrv": "hr", "hun": "hu", "hye": "hy", "ice": "is", "ind": "id", "isl": "is", "ita": "it", "jpn": "ja", "kan": "kn", "kat": "ka", "kaz": "kk", "khm": "km", "kor": "ko", "lao": "lo", "lat": "la", "lav": "lv", "lit": "lt", "ltz": "lb", "mac": "mk", "mal": "ml", "mar": "mr", "may": "ms", "mkd": "mk", "mlt": "mt", "mon": "mn", "msa": "ms", "mya": "my", "nep": "ne", "nld": "nl", "nno": "no", "nob": "no", "nor": "no", "pan": "pa", "per": "fa", "pol": "pl", "por": "pt", "ron": "ro", "rum": "ro", "rus": "ru", "sin": "si", "slk": "sk", "slo": "sk", "slv": "sl", "sme": "se", "som": "so", "spa": "es", "sqi": "sq", "srp": "sr", "swa": "sw", "swe": "sv", "tam": "ta", "tel": "te", "tgl": "tl", "tha": "th", "tur": "tr", "ukr": "uk", "urd": "ur", "uzb": "uz", "vie": "vi", "wel": "cy", "xho": "xh", "yid": "yi", "yue": "zh", "zho": "zh", "zul": "zu"}
_LANG2_ALIAS = {"fil": "tl", "in": "id", "iw": "he", "ji": "yi", "jw": "jv", "mo": "ro", "nb": "no", "nn": "no", "sh": "sr"}
_LANG_NAMES = {"bahasa indonesia": "id", "bahasa melayu": "ms", "tieng viet": "vi", "afrikaans": "af", "albanian": "sq", "amharic": "am", "arabic": "ar", "armenian": "hy", "azerbaijani": "az", "azerbaycan": "az", "bangla": "bn", "basque": "eu", "belarusian": "be", "bengali": "bn", "bengali bangla": "bn", "bokmal": "no", "bosanski": "bs", "bosnian": "bs", "brazilian portuguese": "pt", "bulgarian": "bg", "burmese": "my", "canadian french": "fr", "cantonese": "zh", "castellano": "es", "castilian": "es", "catala": "ca", "catalan": "ca", "cesky": "cs", "cestina": "cs", "chinese": "zh", "chinese mandarin cantonese": "zh", "chinese simplified": "zh", "chinese traditional": "zh", "croatian": "hr", "cymraeg": "cy", "czech": "cs", "danish": "da", "dansk": "da", "deutsch": "de", "dutch": "nl", "dutch flemish": "nl", "eesti": "et", "english": "en", "espanol": "es", "estonian": "et", "european spanish": "es", "euskara": "eu", "faroese": "fo", "farsi": "fa", "filipino": "tl", "finnish": "fi", "flemish": "nl", "francais": "fr", "french": "fr", "gaeilge": "ga", "gaelic": "gd", "gaelic scottish gaelic": "gd", "galego": "gl", "galician": "gl", "georgian": "ka", "german": "de", "greek": "el", "gujarati": "gu", "hebrew": "he", "hindi": "hi", "hrvatski": "hr", "hungarian": "hu", "icelandic": "is", "indonesia": "id", "indonesian": "id", "irish": "ga", "islenska": "is", "italian": "it", "italiano": "it", "japanese": "ja", "kannada": "kn", "kazakh": "kk", "khmer": "km", "kiswahili": "sw", "korean": "ko", "lao": "lo", "latin": "la", "latin american spanish": "es", "latina": "la", "latvian": "lv", "latviesu": "lv", "lietuviu": "lt", "lithuanian": "lt", "luxembourgish": "lb", "macedonian": "mk", "magyar": "hu", "malay": "ms", "malayalam": "ml", "maltese": "mt", "mandarin": "zh", "marathi": "mr", "melayu": "ms", "moldavian": "ro", "mongolian": "mn", "nederlands": "nl", "nepali": "ne", "norsk": "no", "northern": "se", "northern sami sami": "se", "norwegian": "no", "norwegian bokmal nynorsk": "no", "nynorsk": "no", "ozbek": "uz", "panjabi": "pa", "persian": "fa", "persian farsi": "fa", "polish": "pl", "polski": "pl", "portugues": "pt", "portuguese": "pt", "portuguese brazilian": "pt", "punjabi": "pa", "punjabi panjabi": "pa", "romana": "ro", "romanian": "ro", "romanian moldavian": "ro", "russian": "ru", "russkij": "ru", "sami": "se", "scottish": "gd", "serbian": "sr", "shqip": "sq", "simplified chinese": "zh", "sinhala": "si", "sinhala sinhalese": "si", "sinhalese": "si", "slovak": "sk", "slovencina": "sk", "slovene": "sl", "slovenian": "sl", "slovenian slovene": "sl", "slovenscina": "sl", "slovensky": "sk", "somali": "so", "spanish": "es", "spanish castilian": "es", "spanish latin american": "es", "srpski": "sr", "suomi": "fi", "svenska": "sv", "swahili": "sw", "swedish": "sv", "tagalog": "tl", "tagalog filipino": "tl", "tamil": "ta", "telugu": "te", "thai": "th", "traditional chinese": "zh", "turkce": "tr", "turkish": "tr", "ukrainian": "uk", "urdu": "ur", "uzbek": "uz", "vietnamese": "vi", "vlaams": "nl", "welsh": "cy", "xhosa": "xh", "yiddish": "yi", "zulu": "zu", "ελληνικά": "el", "беларуская": "be", "български": "bg", "македонски": "mk", "русский": "ru", "српски": "sr", "українська": "uk", "қазақ": "kk", "հայերեն": "hy", "עברית": "he", "اردو": "ur", "العربية": "ar", "فارسی": "fa", "हिन्दी": "hi", "বাংলা": "bn", "தமிழ்": "ta", "తెలుగు": "te", "ไทย": "th", "ქართული": "ka", "中文": "zh", "日本語": "ja", "普通话": "zh", "粤语": "zh", "한국어": "ko"}


def _fold(text: str) -> str:
    """lower case without accents (keeps non-Latin scripts)"""
    t = unicodedata.normalize("NFKD", text.strip().lower())
    return "".join(ch for ch in t if not unicodedata.combining(ch))


def lang(code: str | None) -> str | None:
    """One ISO 639-1 code for a language, whatever form the source uses: "cs", "cze", "ces", "cs-CZ",
    "Czech", "Čeština", "Czech (Forced)" all give "cs". Unknown names are dropped."""
    if not code:
        return None
    t = re.sub(r"[\(\[].*?[\)\]]", " ", _fold(code)).replace("_", "-").strip(" -.,")
    if not t:
        return None
    if t in _LANG_NAMES:
        return _LANG_NAMES[t]
    c = re.split(r"[-\s]", t)[0]
    if c in ("und", "zxx", "mis", "mul", "unk", "unknown", "original", "other", ""):
        return None
    if len(c) == 2 and c.isascii() and c.isalpha():
        return _LANG2_ALIAS.get(c, c)
    if len(c) == 3 and c.isascii() and c.isalpha():
        return _LANG3.get(c) or _LANG2_ALIAS.get(c) or c
    return _LANG_NAMES.get(c)


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

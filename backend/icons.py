"""Guess a device icon from UniFi fingerprint, vendor and hostname."""
import re

RULES = [
    ("ap", r"\bu6\b|u7|uap|ac ?pro|access ?point|nanohd|ac-lite|ac lite"),
    ("switch", r"\busw\b|switch(?! ?lite)|flex ?mini"),
    ("router", r"router|fritz|avm audiovisuelles|opnsense|gateway|modem"),
    ("solar", r"opendtu|ahoy|hoymiles|inverter|wechselrichter|solar"),
    ("plug", r"shelly ?plug|shellyplus ?plug|tasmota|sonoff|steckdose|plug"),
    ("energy", r"shellypro3em|shelly ?3em|\bem\b|zaehler|zähler|meter"),
    ("phone", r"iphone|android|galaxy|pixel|\bs2\d|ultra|phone|oneplus|xiaomi|redmi|huawei|motorola|nokia"),
    ("tablet", r"ipad|tab\b|tablet|kindle"),
    ("laptop", r"macbook|laptop|thinkpad|notebook|xps|zenbook|surface"),
    ("watch", r"watch"),
    ("printer", r"printer|epson|brother|canon|laserjet|officejet|kyocera"),
    ("tv", r"\btv\b|chromecast|roku|fire ?tv|appletv|apple tv|bravia|webos|tizen|shield"),
    ("speaker", r"sonos|echo|homepod|nest ?(mini|audio)|speaker|alexa"),
    ("game", r"playstation|ps[45]|xbox|nintendo|steam ?deck|steamdeck"),
    ("vr", r"quest|steam ?frame|index|vive"),
    ("camera", r"camera|cam\b|axis|reolink|hikvision|dahua|doorbell"),
    ("nas", r"synology|diskstation|qnap|truenas|\bnas\b"),
    ("server", r"unraid|server|proxmox|esxi|idrac|ilo|ipmi|raspberry|\bpi\b"),
    ("vm", r"qemu|vmware|virtualbox|kvm|docker"),
    ("homeassistant", r"home ?assistant|homeassistant|\bha\b"),
    ("iot", r"esp|espressif|tuya|shelly|zigbee|tasmota|smart|iot|ac_|net_ac|aqara|tado|hue|nanoleaf|govee|wled"),
    ("desktop", r"desktop|\bpc\b|workstation|imac|tower|cachyos|-pc\b"),
]

UNIFI_CAT = {
    1: "laptop", 2: "phone", 3: "phone", 4: "tablet", 5: "camera", 6: "phone", 7: "game", 9: "tv", 13: "printer",
    14: "speaker", 17: "watch", 20: "iot", 25: "tv", 29: "camera", 31: "tv", 33: "nas", 44: "desktop", 47: "server",
}


def guess(dev, unifi_client=None, infra=None):
    if infra:
        return {"uap": "ap", "usw": "switch", "ugw": "router", "udm": "router", "uxg": "router"}.get(infra.get("type"), "router")
    if unifi_client:
        cat = unifi_client.get("dev_cat")
        if cat in UNIFI_CAT:
            return UNIFI_CAT[cat]
    text = " ".join(str(x) for x in (
        dev.get("custom_name"), dev.get("hostname"), dev.get("name"), dev.get("vendor"),
        (unifi_client or {}).get("os"), (unifi_client or {}).get("dev_vendor"),
    ) if x).lower()
    for icon, rx in RULES:
        if re.search(rx, text):
            return icon
    vendor = (dev.get("vendor") or "").lower()
    if "apple" in vendor:
        return "phone"
    if (dev.get("network") or "").lower().startswith("iot"):
        return "iot"
    if (dev.get("network") or "").lower().startswith("server"):
        return "server"
    return "unknown"

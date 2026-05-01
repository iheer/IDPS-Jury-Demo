import os
import random
import threading
import time
from datetime import datetime
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

monitoring_active = False
monitor_thread = None

state = {
    "status": "stopped",
    "started_at": None,
    "packets_analyzed": 0,
    "suspicious_events": 0,
    "blocked_ips": [],
    "alerts": [],
    "events": [],
    "network": {
        "interface": "Wi-Fi",
        "mode": "demo",
        "throughput_mbps": 0.0,
        "latency_ms": 0,
        "packet_rate": 0
    }
}

SEVERITIES = ["low", "medium", "high", "critical"]
ATTACK_TYPES = {
    "port_scan": {
        "title": "Port Scan Detected",
        "description": "Multiple sequential connection attempts detected across ports.",
        "severity": "high",
        "source_ip": "192.168.1.45",
        "destination_ip": "192.168.1.10"
    },
    "brute_force": {
        "title": "Brute Force Attempt",
        "description": "Repeated authentication failures from a single source.",
        "severity": "critical",
        "source_ip": "10.0.0.23",
        "destination_ip": "192.168.1.10"
    },
    "ddos": {
        "title": "Traffic Spike / DDoS Pattern",
        "description": "Abnormal burst traffic pattern detected against local host.",
        "severity": "critical",
        "source_ip": "172.16.0.99",
        "destination_ip": "192.168.1.10"
    },
    "exfiltration": {
        "title": "Possible Data Exfiltration",
        "description": "Large outbound transfer to unusual destination detected.",
        "severity": "high",
        "source_ip": "192.168.1.10",
        "destination_ip": "45.77.12.200"
    }
}


def now_iso():
    return datetime.utcnow().isoformat() + "Z"


def add_event(event_type, source_ip, destination_ip, protocol, severity, message, action="observed"):
    event = {
        "id": len(state["events"]) + 1,
        "timestamp": now_iso(),
        "type": event_type,
        "source_ip": source_ip,
        "destination_ip": destination_ip,
        "protocol": protocol,
        "severity": severity,
        "message": message,
        "action": action
    }
    state["events"].insert(0, event)
    state["events"] = state["events"][:200]
    return event


def add_alert(title, description, severity, source_ip, destination_ip, recommendation, status="open"):
    alert = {
        "id": len(state["alerts"]) + 1,
        "timestamp": now_iso(),
        "title": title,
        "description": description,
        "severity": severity,
        "source_ip": source_ip,
        "destination_ip": destination_ip,
        "recommendation": recommendation,
        "status": status
    }
    state["alerts"].insert(0, alert)
    state["alerts"] = state["alerts"][:100]
    state["suspicious_events"] += 1
    return alert


def monitor_loop():
    while monitoring_active:
        state["packets_analyzed"] += random.randint(20, 80)
        state["network"]["throughput_mbps"] = round(random.uniform(8.5, 95.0), 2)
        state["network"]["latency_ms"] = random.randint(4, 45)
        state["network"]["packet_rate"] = random.randint(120, 1100)

        if random.random() < 0.35:
            src = f"192.168.1.{random.randint(2, 254)}"
            dst = "192.168.1.10"
            protocol = random.choice(["TCP", "UDP", "HTTP", "HTTPS", "ICMP"])
            severity = random.choice(SEVERITIES[:-1])
            message = random.choice([
                "Suspicious connection burst observed",
                "Unusual traffic signature matched",
                "Repeated port access pattern detected",
                "Anomalous internal traffic behavior"
            ])
            add_event("anomaly", src, dst, protocol, severity, message)

        if random.random() < 0.18:
            src = f"10.0.0.{random.randint(2, 254)}"
            dst = "192.168.1.10"
            sev = random.choice(["medium", "high"])
            add_alert(
                title="Anomalous Traffic Alert",
                description="Traffic behavior deviates from baseline thresholds.",
                severity=sev,
                source_ip=src,
                destination_ip=dst,
                recommendation="Inspect the source host and review recent sessions."
            )

        time.sleep(2)


@app.get("/health")
def health():
    return jsonify({
        "success": True,
        "status": "ok",
        "backend": "running",
        "timestamp": now_iso()
    })


@app.post("/monitoring/start")
def start_monitoring():
    global monitoring_active, monitor_thread

    if monitoring_active:
        return jsonify({
            "success": True,
            "message": "Monitoring already active",
            "status": "running"
        })

    monitoring_active = True
    state["status"] = "running"
    state["started_at"] = now_iso()

    monitor_thread = threading.Thread(target=monitor_loop, daemon=True)
    monitor_thread.start()

    add_event(
        event_type="system",
        source_ip="127.0.0.1",
        destination_ip="127.0.0.1",
        protocol="LOCAL",
        severity="low",
        message="Monitoring started",
        action="initiated"
    )

    return jsonify({
        "success": True,
        "message": "Monitoring started successfully",
        "status": "running"
    })


@app.post("/monitoring/stop")
def stop_monitoring():
    global monitoring_active

    monitoring_active = False
    state["status"] = "stopped"

    add_event(
        event_type="system",
        source_ip="127.0.0.1",
        destination_ip="127.0.0.1",
        protocol="LOCAL",
        severity="low",
        message="Monitoring stopped",
        action="stopped"
    )

    return jsonify({
        "success": True,
        "message": "Monitoring stopped",
        "status": "stopped"
    })


@app.get("/status")
def status():
    return jsonify({
        "success": True,
        "status": "connected" if monitoring_active else "disconnected",
        "engine": state["status"],
        "monitoring_active": monitoring_active,
        "started_at": state["started_at"],
        "network": state["network"]
    })


@app.get("/stats")
def stats():
    return jsonify({
        "success": True,
        "stats": {
            "packets_analyzed": state["packets_analyzed"],
            "suspicious_events": state["suspicious_events"],
            "blocked_ips": len(state["blocked_ips"]),
            "active_alerts": len([a for a in state["alerts"] if a["status"] == "open"]),
            "throughput_mbps": state["network"]["throughput_mbps"],
            "latency_ms": state["network"]["latency_ms"],
            "packet_rate": state["network"]["packet_rate"]
        }
    })


@app.get("/alerts")
def alerts():
    return jsonify({
        "success": True,
        "alerts": state["alerts"]
    })


@app.get("/events")
def events():
    return jsonify({
        "success": True,
        "events": state["events"]
    })


@app.post("/simulate")
def simulate():
    payload = request.get_json(silent=True) or {}
    attack_type = payload.get("attack_type", "port_scan")

    if attack_type not in ATTACK_TYPES:
        return jsonify({
            "success": False,
            "error": f"Unknown attack type: {attack_type}"
        }), 400

    attack = ATTACK_TYPES[attack_type]

    event = add_event(
        event_type=attack_type,
        source_ip=attack["source_ip"],
        destination_ip=attack["destination_ip"],
        protocol="TCP",
        severity=attack["severity"],
        message=attack["description"],
        action="detected"
    )

    alert = add_alert(
        title=attack["title"],
        description=attack["description"],
        severity=attack["severity"],
        source_ip=attack["source_ip"],
        destination_ip=attack["destination_ip"],
        recommendation="Review traffic, isolate host if needed, and block the offending IP."
    )

    state["packets_analyzed"] += random.randint(150, 400)

    return jsonify({
        "success": True,
        "message": f"{attack_type} simulation generated",
        "event": event,
        "alert": alert
    })


@app.post("/block-ip")
def block_ip():
    payload = request.get_json(silent=True) or {}
    ip = payload.get("ip")

    if not ip:
        return jsonify({
            "success": False,
            "error": "IP is required"
        }), 400

    if ip not in state["blocked_ips"]:
        state["blocked_ips"].append(ip)

    add_event(
        event_type="response",
        source_ip="127.0.0.1",
        destination_ip=ip,
        protocol="LOCAL",
        severity="medium",
        message=f"IP {ip} added to block list",
        action="blocked"
    )

    for alert in state["alerts"]:
        if alert["source_ip"] == ip and alert["status"] == "open":
            alert["status"] = "mitigated"

    return jsonify({
        "success": True,
        "message": f"IP {ip} blocked successfully",
        "blocked_ips": state["blocked_ips"]
    })


@app.get("/report")
def report():
    return jsonify({
        "success": True,
        "generated_at": now_iso(),
        "summary": {
            "status": state["status"],
            "started_at": state["started_at"],
            "packets_analyzed": state["packets_analyzed"],
            "suspicious_events": state["suspicious_events"],
            "blocked_ips_count": len(state["blocked_ips"]),
            "active_alerts": len([a for a in state["alerts"] if a["status"] == "open"])
        },
        "network": state["network"],
        "blocked_ips": state["blocked_ips"],
        "recent_alerts": state["alerts"][:10],
        "recent_events": state["events"][:20]
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="127.0.0.1", port=port, debug=False)
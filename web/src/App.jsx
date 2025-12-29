import { useState, useEffect } from "react";
import { Container, Button, Card, Badge, Alert, Spinner } from "react-bootstrap";
import {beautifyDtekHtml} from "./utils/beautifyDtekHtml.js";

// API base:
// - In production (Render static site), set VITE_API_BASE_URL to your server URL
// - In local dev, it falls back to http://localhost:3001
const API_BASE = (import.meta?.env?.VITE_API_BASE_URL || "http://localhost:3001").replace(/\/$/, "");

function getAddressFromUrl() {
    const p = new URLSearchParams(window.location.search);
    const city = (p.get("city") || "").trim();
    const street = (p.get("street") || "").trim();
    const house = (p.get("house") || "").trim();
    const hasAll = Boolean(city && street && house);
    const text = hasAll ? `${city}, ${street}, ${house}` : "";
    return { city, street, house, hasAll, text };
}

function StatusBadge({ status }) {
    const map = {
        OFF: { t: "Немає світла", bg: "danger" },
        ON: { t: "Світло є", bg: "success" },
        UNKNOWN: { t: "Невідомо", bg: "secondary" },
    };
    const b = map[status] ?? map.UNKNOWN;
    return <Badge bg={b.bg}>{b.t}</Badge>;
}

export default function App() {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState("");

    const addr = getAddressFromUrl();

    const check = async () => {
        setLoading(true);
        setErr("");
        try {
            const a = getAddressFromUrl();
            const url = a.hasAll
                ? `${API_BASE}/api/status?${new URLSearchParams({
                    city: a.city,
                    street: a.street,
                    house: a.house,
                }).toString()}`
                : `${API_BASE}/api/status`;

            const r = await fetch(url);
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error || "API error");
            setData(j);
        } catch (e) {
            setErr(`${String(e)}\n\nAPI: ${API_BASE}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (addr.hasAll) check();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [addr.city, addr.street, addr.house]);

    const currentStatus = data?.current?.status ?? "UNKNOWN";

    return (
        <Container className="py-4">
            <div className="d-flex align-items-center justify-content-between gap-2">
                <h2 className="m-0">Перевірка світла {addr.hasAll && <span style={{ fontSize: "1.2rem" }}>для <em className="headerAddress">"{addr.text}"</em></span>}</h2>
                <Button onClick={check} disabled={loading}>
                    {loading ? (
                        <>
                            <Spinner size="sm" className="me-2" />
                            Перевіряю...
                        </>
                    ) : (
                        "Перевірити"
                    )}
                </Button>
            </div>

            {err && (
                <Alert variant="danger" className="mt-3" style={{ whiteSpace: "pre-wrap" }}>
                    {err}
                </Alert>
            )}

            {!data && !err && (
                <div className="mt-3 text-muted">
                    Натисни “Перевірити”, щоб отримати статус, чергу і графік.
                </div>
            )}

            {data && (
                <Card className="mt-3">
                    <Card.Body>
                        <div className="d-flex flex-wrap align-items-center gap-2">
                            <StatusBadge status={currentStatus} />

                            {data.groupName && <Badge bg="info">{data.groupName}</Badge>}

                            {data.scheduleUpdatedAt && (
                                <span className="text-muted" style={{ fontSize: 13 }}>
                  Оновлено (графік): {data.scheduleUpdatedAt}
                </span>
                            )}
                        </div>
                        {data?.resolvedAddress?.text && (
                            <div style={{ marginTop: 8, fontSize: 14, opacity: 0.85 }}>
                                📍 Адреса: <strong>{data.resolvedAddress.text}</strong>
                            </div>
                        )}


                        {data.current?.text && (
                            <div className="mt-2" style={{ whiteSpace: "pre-wrap" }}>
                                {data.current.text}
                            </div>
                        )}

                        <hr className="my-4" />

                        {data?.factHtml ? (
                            <section>
                                <h5 className="mb-2">Графік на сьогодні</h5>
                                <div className="dtek-fact"><div dangerouslySetInnerHTML={{__html: beautifyDtekHtml(data.factHtml)}}/></div>
                            </section>
                        ) : (
                            <div className="text-muted">Графік (на сьогодні) недоступний</div>
                        )}

                        <hr className="my-4" />

                        {data?.weekHtml ? (
                            <section>
                                <h5 className="mb-2">Графік на тиждень</h5>
                                <div className="dtek-week"><div dangerouslySetInnerHTML={{__html: beautifyDtekHtml(data.weekHtml)}}/></div>

                            </section>
                            ) : data?.weekNote ? (
                            <Alert variant="warning" className="mb-0">
                                {data.weekNote}
                            </Alert>
                        ) : (
                            <div className="text-muted">Тижневий графік недоступний</div>
                        )}
                    </Card.Body>
                </Card>
            )}
        </Container>
    );
}

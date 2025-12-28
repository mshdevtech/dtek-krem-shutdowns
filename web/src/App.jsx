import { useState } from "react";
import { Container, Button, Card, Badge, Alert, Spinner } from "react-bootstrap";
import {beautifyDtekHtml} from "./utils/beautifyDtekHtml.js";

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

    const check = async () => {
        setLoading(true);
        setErr("");
        try {
            const r = await fetch("http://localhost:3001/api/status");
            const j = await r.json();
            if (!r.ok) throw new Error(j?.error || "API error");
            setData(j);
        } catch (e) {
            setErr(String(e));
        } finally {
            setLoading(false);
        }
    };

    const currentStatus = data?.current?.status ?? "UNKNOWN";

    return (
        <Container className="py-4">
            <div className="d-flex align-items-center justify-content-between gap-2">
                <h2 className="m-0">Перевірка світла</h2>

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

                        {data.current?.text && (
                            <div className="mt-3" style={{ whiteSpace: "pre-wrap" }}>
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

export async function fetchDashboard(token, { start, end } = {}) {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const qs = params.toString();
  const res = await fetch(`/api/dashboard/${token}${qs ? `?${qs}` : ""}`);
  if (res.status === 404) {
    const err = new Error("not_found");
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

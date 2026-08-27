// CR2 #2 asked for a 401 here so a mistyped link doesn't read as "the site is
// down". We kept the 404 (CANDIDATE-BRIEF.md: "Wrong or unknown token → 404 —
// not 401, not a redirect" -- a private link is the only access control this
// product has, and a 401 would tell a stranger probing URLs "this dashboard
// exists but you're not authorized", which is exactly the information an
// unguessable link is supposed to withhold). What we changed instead is this
// copy, so a legitimate operator with a stale link isn't left guessing.
export default function NotFoundPage() {
  return (
    <div className="page-center">
      <div className="not-found">
        <h1>404</h1>
        <p>This link is invalid or has expired. Ask us for a new one — nothing is wrong on our end.</p>
      </div>
    </div>
  );
}

import { ReactNode } from "react";

export function SectionCard({ title, children, kicker }: { title: string; children: ReactNode; kicker?: string }) {
  return (
    <section className="card">
      {kicker ? <div className="section-kicker">{kicker}</div> : null}
      <h3>{title}</h3>
      {children}
    </section>
  );
}

import { useEffect, useState } from "react";
import { getJson } from "./api";

type Project = { id: string; name: string; root: string };

export function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJson<{ projects: Project[] }>("/api/projects")
      .then((body) => setProjects(body.projects))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error !== null) return <p className="p-4 text-destructive">{error}</p>;
  if (projects === null) return null;
  if (projects.length === 0)
    return <p className="p-4">No projects yet: run crank-mem init in a project.</p>;
  return (
    <ul className="p-4">
      {projects.map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  );
}

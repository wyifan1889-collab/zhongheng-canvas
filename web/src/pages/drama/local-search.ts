export function searchLocalDramaProjects<T extends { name: string }>(projects: T[], query: string): T[] {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? projects.filter(project => project.name.toLocaleLowerCase().includes(needle)) : projects;
}

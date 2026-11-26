export function searchLocalCanvases<T extends { title: string }>(projects: T[], query: string): T[] {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? projects.filter(project => project.title.toLocaleLowerCase().includes(needle)) : projects;
}

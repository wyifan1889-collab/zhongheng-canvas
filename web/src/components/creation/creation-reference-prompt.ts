import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { referenceLabelPattern } from "@/lib/reference-label-tokens";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { ReferenceImage } from "@/types/image";

export function creationReferenceCandidates(references: ReferenceImage[]): CanvasResourceReference[] {
    return references.map((reference, index) => ({ id: reference.id, nodeId: reference.id, kind: "image", label: imageReferenceLabel(index), title: reference.name, previewUrl: reference.dataUrl, active: true }));
}

// The original image request labels references by their transmitted array order.
// Keep existing mentions attached to the same image when removing a preceding row.
export function removeCreationReference(prompt: string, references: ReferenceImage[], id: string) {
    return reindexCreationReferences(prompt, references, references.filter(reference => reference.id !== id));
}

export function reindexCreationReferences(prompt: string, references: ReferenceImage[], next: ReferenceImage[]) {
    const labels = new Map(references.map((reference, index) => [imageReferenceLabel(index), next.some(item => item.id === reference.id) ? imageReferenceLabel(next.findIndex(item => item.id === reference.id)) : ""]));
    const pattern = referenceLabelPattern([...labels.keys()]);
    return { prompt: pattern ? prompt.replace(pattern, label => labels.get(label) ?? label) : prompt, references: next };
}

import { mappingSourceKey, mappingSpecKey, mappingCombinationKey, mappingBindingKey, parseMappingExecution, validMappingSpecification, type MappingSource, type MappingModel, type MappingDraft, type MappingBinding, type MappingExecution } from "../../../../packages/shared/src/model-mapping-drafts";
import { mappingExecutionKey } from "../../../../packages/shared/src/model-mapping-execution";
import { GEMINI_IMAGE_PROTOCOL, parseGeminiImageSpecification } from "../../../../packages/shared/src/generation-gemini-image";
export * from "../../../../packages/shared/src/model-mapping-drafts";
export type MappingSuggestion = MappingModel & { specification: string | null; caution: string | null };

/** Suggestions never establish model identity, protocol support or a default size. */
export function suggestModelMapping(raw: string): MappingSuggestion | null {
    const image = /^(?:gpt-)?image-(\d+(?:[.-]\d+)?)(?:-(flare|sunburst))?(?:-([1-9]\d*k))?$/i.exec(raw);
    if (image) {
        const version = image[1].replace("-", "."), variant = image[2]?.toLowerCase();
        return { id: `image-${version}${variant ? `-${variant}` : ""}`, displayName: `Image ${version}${variant ? ` ${variant === "flare" ? "Flare" : "Sunburst"}` : ""}`,
            capability: "image", group: "", specification: image[3]?.toUpperCase() ?? null,
            caution: variant ? "Flare / Sunburst 的含义待核实，暂按独立模型整理" : !image[3] ? "无规格后缀，不能认定为 2K" : null };
    }
    const video = /^(sd\d+(?:\.\d+)?)-(fast|mini)-(\d{3,4}p)$/i.exec(raw);
    if (video) return { id: `${video[1]}-${video[2]}`.toLowerCase(), displayName: `${video[1].replace(/^sd/i, "SD ")} ${video[2].toLowerCase() === "fast" ? "Fast" : "Mini"}`,
        capability: "video", group: "", specification: video[3].toUpperCase(), caution: null };
    return null;
}

export function addMapping(draft: MappingDraft, source: MappingSource, model: MappingModel, specification: string, execution?: MappingExecution): MappingDraft {
    if (!source.available) throw new Error("该型号已不在渠道目录中，请重新读取后核对");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(model.id) || !model.displayName.trim() ||
        !validMappingSpecification(specification, model.capability)) throw new Error("请填写模型、节点类型和明确的清晰度规格");
    const target = draft.models.find(item => item.id === model.id);
    if (target && target.capability !== model.capability) throw new Error("同一平台模型不能同时属于图片和视频节点");
    const parsed = execution ? parseMappingExecution(execution, model.capability, specification) : undefined;
    if (parsed === null) throw new Error("请核对协议与完整参数；展示标签不能代替实际参数");
    if (parsed?.protocol === GEMINI_IMAGE_PROTOCOL && !parseGeminiImageSpecification(source.providerModel, parsed.parameters)) throw new Error("该精确型号不支持所选原生图片规格");
    const binding: MappingBinding = { providerId: source.providerId, providerModel: source.providerModel, modelId: model.id, specification, ...(parsed ? { execution: parsed } : {}) };
    const existing = draft.bindings.filter(item => mappingSourceKey(item) === mappingSourceKey(source));
    if (existing.some(item => item.modelId !== model.id)) throw new Error("这个渠道型号已有映射到其他模型，请先移除原映射再重新配置");
    if (parsed && existing.some(item => item.execution && mappingExecutionKey(item.execution) === mappingExecutionKey(parsed) && item.specification !== specification))
        throw new Error("同一来源的相同调用参数不能标为不同清晰度，请核对尺寸与展示规格");
    if (existing.some(item => mappingBindingKey(item) === mappingBindingKey(binding))) return draft;
    return { ...draft, models: target ? draft.models : [...draft.models, { id: model.id, displayName: model.displayName.trim(), capability: model.capability, group: model.group }],
        specificationOptions: { ...draft.specificationOptions, [model.capability]: [...new Set([...draft.specificationOptions[model.capability], specification])] },
        modelSpecifications: target ? draft.modelSpecifications : { ...draft.modelSpecifications, [model.id]: [...new Set([...draft.specificationOptions[model.capability], specification])] },
        bindings: [...draft.bindings, binding] };
}

export function removeMappingBindings(draft: MappingDraft, remove: (binding: MappingBinding) => boolean): MappingDraft {
    const bindings = draft.bindings.filter(binding => !remove(binding));
    const remaining = new Map<string, Set<string>>();
    for (const binding of bindings) {
        const key = mappingCombinationKey(binding), routes = remaining.get(key) ?? new Set<string>();
        routes.add(mappingSourceKey(binding)); remaining.set(key, routes);
    }
    // An explicit cleared preference prevents removal from selecting another route.
    return { ...draft, bindings, preferred: Object.fromEntries(Object.entries(draft.preferred).filter(([spec]) => remaining.has(spec)).map(([spec, value]) => [spec, value && remaining.get(spec)!.has(value) ? value : null])),
        prices: Object.fromEntries(Object.entries(draft.prices).filter(([spec]) => remaining.has(spec))) };
}
export function removeMappingSource(draft: MappingDraft, source: Pick<MappingSource, "providerId" | "providerModel">): MappingDraft {
    return removeMappingBindings(draft, binding => mappingSourceKey(binding) === mappingSourceKey(source));
}
export function replaceMappingBinding(draft: MappingDraft, source: MappingSource, model: MappingModel, specification: string, execution?: MappingExecution, previous?: MappingBinding): MappingDraft {
    if (!previous) return addMapping(draft, source, model, specification, execution);
    const key = mappingBindingKey(previous);
    if (!draft.bindings.some(binding => mappingBindingKey(binding) === key)) throw new Error("原组合已变化，请重新打开核对");
    // Identical edits preserve the preference and price. Changed parameters deliberately require a new price.
    if (mappingCombinationKey(previous) === mappingSpecKey(model.id, specification, execution)) return draft;
    if (draft.bindings.some(binding => mappingSourceKey(binding) === mappingSourceKey(source) && mappingCombinationKey(binding) === mappingSpecKey(model.id, specification, execution)))
        throw new Error("该来源已有相同参数组合，请编辑已有组合，原输入已保留");
    return addMapping(removeMappingBindings(draft, binding => mappingBindingKey(binding) === key), source, model, specification, execution);
}

export function mappingParameterLabel(binding: Pick<MappingBinding, "execution">): string {
    const execution = binding.execution;
    if (!execution) return "待配置实际参数";
    const p = execution.parameters;
    if (execution.protocol === "openai-image-v1") return `${execution.parameters.size} · ${{ low: "低", medium: "中", high: "高" }[execution.parameters.quality]}画质${execution.maxImagesPerRequest === undefined ? "" : ` · 单次最多 ${execution.maxImagesPerRequest} 张`}`;
    if (execution.protocol === GEMINI_IMAGE_PROTOCOL) return `${execution.parameters.imageSize} · ${execution.parameters.aspectRatio} · 按交付张数`;
    if ("mode" in p) return `${p.mode === "text" ? `文生视频 · ${p.aspectRatio}` : "首帧生视频"} · ${p.durationSeconds}秒 · ${p.generateAudio ? "有声" : "无声"}`;
    return "";
}

export function previewMappingRoute(draft: MappingDraft, sources: readonly MappingSource[], modelId: string, specification: string, execution?: MappingExecution):
    { status: "ready"; source: MappingSource } | { status: "missing" | "unavailable" | "choose_channel" } {
    const spec = mappingSpecKey(modelId, specification, execution);
    const bindings = draft.bindings.filter(item => mappingCombinationKey(item) === spec);
    const directory = new Map(sources.map(source => [mappingSourceKey(source), source]));
    const preferred = draft.preferred[spec];
    // A missing preferred route never silently switches to another channel.
    const selected = Object.hasOwn(draft.preferred, spec) ? bindings.find(item => mappingSourceKey(item) === preferred) : bindings.length === 1 ? bindings[0] : undefined;
    if (!selected) return { status: bindings.length ? "choose_channel" : "missing" };
    const source = directory.get(mappingSourceKey(selected));
    if (!source?.available) return { status: "missing" };
    return source.providerEnabled ? { status: "ready", source } : { status: "unavailable" };
}


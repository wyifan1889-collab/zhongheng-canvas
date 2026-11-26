import { create } from "zustand";
import {
    evaluatePriceRule, normalizePriceAmount, parseModelPriceRules,
    type ModelPriceRule, type ModelPriceRules, type PriceMeter, type PriceSampleResult,
} from "../../../../../packages/shared/src/model-pricing-drafts";

export { PRICE_METERS, PRICE_TEMPLATES } from "../../../../../packages/shared/src/model-pricing-drafts";
export type { ModelPriceRule, ModelPriceRules, PriceBand, PriceMeter, PriceTemplate, PriceSampleResult } from "../../../../../packages/shared/src/model-pricing-drafts";

// In-memory, synthetic walkthrough only. No network, credentials, browser storage or billing.
export type Kind = "text" | "image" | "video";
export type Channel = { id: string; name: string; endpoint: string; adapter: "openai-compatible" | "sub2api"; enabled: boolean };
export type CatalogModel = { id: string; channelId: string; upstreamId: string; name: string; brand: string; kind: Kind | "unknown"; available: boolean };
export type DiscoveredModel = Pick<CatalogModel, "upstreamId" | "name" | "brand" | "kind">;
export type Group = { id: string; kind: Kind; name: string };
export type Assignment = {
    id: string; catalogId: string; kind: Kind; groupId: string; name: string; rules: ModelPriceRules; note: string;
    published?: { version: number; name: string; groupId: string; rules: ModelPriceRules; note: string };
};
export type PublishedModel = { id: string; kind: Kind; name: string; groupId: string; brand: string; sale: ModelPriceRule; note: string; version: number };
export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };
export type PreviewData = { channels: Channel[]; catalog: CatalogModel[]; groups: Group[]; assignments: Assignment[] };
export type PreviewState = PreviewData & {
    saveChannel: (channel: Omit<Channel, "id"> & { id?: string }, models: DiscoveredModel[]) => ActionResult;
    updateCatalog: (channelId: string, models: DiscoveredModel[]) => ActionResult;
    classifyModel: (id: string, kind: Kind, brand: string) => ActionResult;
    toggleChannel: (id: string, enabled: boolean) => ActionResult;
    createGroup: (kind: Kind, name: string) => ActionResult;
    renameGroup: (id: string, name: string) => ActionResult;
    moveGroup: (id: string, direction: -1 | 1) => void;
    addAssignment: (catalogId: string, kind: Kind, groupId: string) => ActionResult;
    updateAssignment: (id: string, patch: Partial<Pick<Assignment, "name" | "groupId" | "rules" | "note">>) => ActionResult;
    publishAssignment: (id: string) => ActionResult;
    unpublishAssignment: (id: string) => void;
    reset: () => void;
};

const clone = <T,>(value: T): T => structuredClone(value);
const fail = (error: string): ActionResult => ({ ok: false, error });
const kinds: Kind[] = ["text", "image", "video"];
const validKind = (kind: unknown): kind is Kind => kinds.includes(kind as Kind);
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function blankRules(kind: Kind): ModelPriceRules {
    const template = kind === "text" ? "text_tokens" : kind === "image" ? "image_count" : "video_second";
    const parameters: Record<string, string>[] = kind === "text" ? [{}] : kind === "image"
        ? ["1K", "2K", "4K"].map(size => ({ size }))
        : ["720p", "1080p"].flatMap(resolution => ["5", "10"].map(durationSeconds => ({ resolution, durationSeconds })));
    const meters: PriceMeter[] = kind === "text" ? ["input_token", "output_token"] : [kind === "image" ? "image" : "second"];
    return {
        schemaVersion: 1,
        cost: { template, currency: "CNY", bands: parameters.map(p => ({ parameters: { ...p }, rates: Object.fromEntries(meters.map(m => [m, null])) })) },
        sale: { template, currency: "credit", bands: parameters.map(p => ({ parameters: { ...p }, rates: Object.fromEntries(meters.map(m => [m, ""])) })) },
    };
}

/** Validation before simulated publication; empty is different from an explicit zero. */
export function validateAssignment(assignment: Assignment): string | null {
    if (!assignment.name.trim()) return "请填写用户看到的模型名称。";
    const rules = parseModelPriceRules(assignment.rules, assignment.kind);
    if (!rules) return "请填写每个规格的完整售价；未知成本留空，免费价格请明确填写 0。规格组合不能重复。";
    if (assignment.kind === "image" && (!["image_count", "image_request"].includes(rules.sale.template) || (rules.cost && !["image_count", "image_request"].includes(rules.cost.template)))) return "本预览的图片支持按张或按次计价。";
    const required = assignment.kind === "video" ? ["resolution", "durationSeconds"] : assignment.kind === "image" ? ["size"] : [];
    if (rules.sale.bands.some(band => required.some(key => !band.parameters[key]))) return "每个规格必须包含分辨率，视频还需包含支持的时长。";
    if (rules.cost) {
        const spec = (rule: ModelPriceRule) => rule.bands.map(band => JSON.stringify(Object.entries(band.parameters).sort())).sort().join("|");
        if (spec(rules.cost) !== spec(rules.sale)) return "成本与售价必须使用相同的规格组合；计费单位可分别配置。";
    }
    return null;
}

export function getPublishedModels(state: PreviewData, kind: Kind): PublishedModel[] {
    return state.assignments.flatMap(assignment => {
        const source = state.catalog.find(model => model.id === assignment.catalogId);
        const publication = assignment.published;
        if (assignment.kind !== kind || !publication || !source || !state.channels.some(channel => channel.id === source.channelId && channel.enabled)) return [];
        return [{ id: assignment.id, kind, name: publication.name, groupId: publication.groupId, brand: source.brand,
            sale: clone(publication.rules.sale), note: publication.note, version: publication.version }];
    });
}

export function quotePreviewPrice(model: PublishedModel, parameters: Record<string, string>, usage: Partial<Record<PriceMeter, string>>): PriceSampleResult {
    if (model.sale.template === "video_second" && normalizePriceAmount(usage.second) !== normalizePriceAmount(parameters.durationSeconds)) {
        return { status: "invalid_sample", fields: ["second"] };
    }
    return evaluatePriceRule(model.sale, parameters, usage);
}

function fixtureRules(kind: Kind, wholeVideo = false): ModelPriceRules {
    const rules = blankRules(kind);
    if (wholeVideo) rules.sale.template = rules.cost!.template = "video_count";
    const sale = kind === "text" ? [{ input_token: "2", output_token: "8" }] : kind === "image"
        ? [{ image: "1" }, { image: "2" }, { image: "4" }]
        : wholeVideo ? [{ video: "3" }, { video: "5" }, { video: "6" }, { video: "10" }]
            : [{ second: "0.4" }, { second: "0.4" }, { second: "0.8" }, { second: "0.8" }];
    const cost = kind === "text" ? [{ input_token: "0.8", output_token: "3" }] : kind === "image"
        ? [{ image: "0.1" }, { image: "0.2" }, { image: "0.4" }]
        : wholeVideo ? [{ video: "0.3" }, { video: "0.5" }, { video: "0.6" }, { video: "1" }]
            : [{ second: "0.04" }, { second: "0.04" }, { second: "0.08" }, { second: "0.08" }];
    rules.sale.bands.forEach((band, index) => { band.rates = sale[index]; });
    rules.cost!.bands.forEach((band, index) => { band.rates = cost[index]; });
    return rules;
}

export function createPreviewData(): PreviewData {
    const channels: Channel[] = [
        { id: "demo-a", name: "示例渠道 A", endpoint: "https://channel-a.example.invalid", adapter: "openai-compatible", enabled: true },
        { id: "demo-b", name: "示例渠道 B", endpoint: "https://channel-b.example.invalid", adapter: "sub2api", enabled: true },
    ];
    const catalog: CatalogModel[] = [
        { id: "a-gpt", channelId: "demo-a", upstreamId: "gpt-demo-text", name: "GPT 文本示例", brand: "GPT", kind: "text", available: true },
        { id: "a-deepseek", channelId: "demo-a", upstreamId: "deepseek-demo-text", name: "DeepSeek 文本示例", brand: "DeepSeek", kind: "text", available: true },
        { id: "a-gemini", channelId: "demo-a", upstreamId: "gemini-demo-text", name: "Gemini 文本示例", brand: "Gemini", kind: "text", available: true },
        { id: "a-image", channelId: "demo-a", upstreamId: "gpt-demo-image", name: "GPT 图片示例", brand: "GPT", kind: "image", available: true },
        { id: "a-video", channelId: "demo-a", upstreamId: "grok-demo-video", name: "Grok 视频示例", brand: "Grok", kind: "video", available: true },
        { id: "b-gpt", channelId: "demo-b", upstreamId: "gpt-demo-text", name: "GPT 文本示例", brand: "GPT", kind: "text", available: true },
        { id: "b-video", channelId: "demo-b", upstreamId: "demo-video-fixed", name: "整段视频示例", brand: "示例视频", kind: "video", available: true },
        { id: "b-image", channelId: "demo-b", upstreamId: "demo-image-plus", name: "图片增强示例", brand: "示例图片", kind: "image", available: true },
        { id: "b-unknown", channelId: "demo-b", upstreamId: "demo-model-x", name: "未识别模型示例", brand: "待确认", kind: "unknown", available: true },
    ];
    const groups: Group[] = [
        { id: "text-gpt", kind: "text", name: "GPT" }, { id: "text-deepseek", kind: "text", name: "DeepSeek" }, { id: "text-gemini", kind: "text", name: "Gemini" },
        { id: "image-gpt", kind: "image", name: "GPT" }, { id: "video-grok", kind: "video", name: "Grok" }, { id: "video-other", kind: "video", name: "其他视频" },
    ];
    const assignments: Assignment[] = [
        { id: "assigned-text", catalogId: "a-gpt", kind: "text", groupId: "text-gpt", name: "GPT 文本示例", rules: fixtureRules("text"), note: "输入 / 输出分项计价；本机虚构价格。" },
        { id: "assigned-deepseek", catalogId: "a-deepseek", kind: "text", groupId: "text-deepseek", name: "DeepSeek 文本示例", rules: fixtureRules("text"), note: "本机虚构价格，不代表厂商报价。" },
        { id: "assigned-image", catalogId: "a-image", kind: "image", groupId: "image-gpt", name: "GPT 图片示例", rules: fixtureRules("image"), note: "按张计价，分辨率决定价格；示例参数。" },
        { id: "assigned-video", catalogId: "a-video", kind: "video", groupId: "video-grok", name: "Grok 视频示例", rules: fixtureRules("video"), note: "按秒计价，总价 = 对应规格每秒售价 × 所选时长；示例参数。" },
        { id: "assigned-video-fixed", catalogId: "b-video", kind: "video", groupId: "video-other", name: "整段视频示例", rules: fixtureRules("video", true), note: "按整段计价，时长和分辨率共同决定档位；示例参数。" },
    ].map(assignment => ({ ...assignment, published: { version: 1, name: assignment.name, groupId: assignment.groupId, rules: clone(assignment.rules), note: assignment.note } })) as Assignment[];
    return { channels, catalog, groups, assignments };
}

function updateModels(catalog: CatalogModel[], channelId: string, incoming: DiscoveredModel[]): CatalogModel[] {
    const known = new Set(catalog.filter(model => model.channelId === channelId).map(model => model.upstreamId));
    const present = new Set(incoming.map(model => model.upstreamId));
    return [...catalog.map(model => model.channelId === channelId ? { ...model, available: present.has(model.upstreamId) } : model),
        ...incoming.filter(model => !known.has(model.upstreamId)).map(model => ({ ...clone(model), id: id("catalog"), channelId, available: true }))];
}

function validDiscovery(models: DiscoveredModel[]): boolean {
    return models.length > 0 && models.every(model => model.upstreamId.trim() && model.name.trim() && model.brand.trim() && (model.kind === "unknown" || validKind(model.kind)))
        && new Set(models.map(model => model.upstreamId)).size === models.length;
}

export const useModelManagementPreview = create<PreviewState>((set, get) => ({
    ...createPreviewData(),
    saveChannel(channel, models) {
        if (!channel.name.trim() || !validDiscovery(models)) return fail("请先完成示例读取并取得有效、无重复的模型目录，再保存渠道。");
        try {
            const url = new URL(channel.endpoint);
            if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return fail("渠道地址需要是不含凭据或查询参数的 HTTPS 地址。");
        } catch { return fail("请填写有效的渠道地址。"); }
        if (!["openai-compatible", "sub2api"].includes(channel.adapter)) return fail("请选择已支持的协议。");
        if (channel.id && !get().channels.some(item => item.id === channel.id)) return fail("渠道不存在。");
        const saved: Channel = { ...channel, name: channel.name.trim(), id: channel.id ?? id("channel") };
        set(state => ({ channels: channel.id ? state.channels.map(item => item.id === saved.id ? saved : item) : [...state.channels, saved], catalog: updateModels(state.catalog, saved.id, models) }));
        return { ok: true, id: saved.id };
    },
    updateCatalog(channelId, models) {
        if (!get().channels.some(channel => channel.id === channelId)) return fail("渠道不存在。");
        if (!validDiscovery(models)) return fail("读取结果无效或为空；保留原有目录。");
        set(state => ({ catalog: updateModels(state.catalog, channelId, models) }));
        return { ok: true };
    },
    classifyModel(modelId, kind, brand) {
        if (!validKind(kind) || !brand.trim()) return fail("请确认模型类型和厂商名称。");
        if (!get().catalog.some(model => model.id === modelId)) return fail("型号不存在。");
        if (get().assignments.some(item => item.catalogId === modelId && item.kind !== kind)) return fail("此型号已经分配给其他节点类型，请先核对已有配置。");
        set(state => ({ catalog: state.catalog.map(model => model.id === modelId ? { ...model, kind, brand: brand.trim() } : model) }));
        return { ok: true };
    },
    toggleChannel(channelId, enabled) {
        if (!get().channels.some(channel => channel.id === channelId)) return fail("渠道不存在。");
        set(state => ({ channels: state.channels.map(channel => channel.id === channelId ? { ...channel, enabled } : channel) }));
        return { ok: true };
    },
    createGroup(kind, name) {
        if (!validKind(kind) || !name.trim()) return fail("请填写分组名称。");
        if (get().groups.some(group => group.kind === kind && group.name === name.trim())) return fail("该节点已存在同名分组。");
        const group: Group = { id: id("group"), kind, name: name.trim() };
        set(state => ({ groups: [...state.groups, group] }));
        return { ok: true, id: group.id };
    },
    renameGroup(groupId, name) {
        const existing = get().groups.find(group => group.id === groupId);
        if (!existing || !name.trim()) return fail("请填写有效的分组名称。");
        if (get().groups.some(group => group.id !== groupId && group.kind === existing.kind && group.name === name.trim())) return fail("该节点已存在同名分组。");
        set(state => ({ groups: state.groups.map(group => group.id === groupId ? { ...group, name: name.trim() } : group) }));
        return { ok: true };
    },
    moveGroup(groupId, direction) {
        const groups = [...get().groups], index = groups.findIndex(group => group.id === groupId);
        if (index < 0) return;
        const siblings = groups.map((group, i) => group.kind === groups[index].kind ? i : -1).filter(i => i >= 0);
        const target = siblings[siblings.indexOf(index) + direction];
        if (target === undefined) return;
        [groups[index], groups[target]] = [groups[target], groups[index]];
        set({ groups });
    },
    addAssignment(catalogId, kind, groupId) {
        const source = get().catalog.find(model => model.id === catalogId);
        if (!source || !source.available) return fail("请先确认该型号仍在渠道目录中。");
        if (!get().channels.some(channel => channel.id === source.channelId && channel.enabled)) return fail("渠道已停用，请先启用后再分配模型。");
        if (source.kind === "unknown") return fail("先在模型库确认此型号的厂商与模型类型。");
        if (source.kind !== kind || !get().groups.some(group => group.id === groupId && group.kind === kind)) return fail("模型类型与节点分组不匹配。");
        if (get().assignments.some(item => item.catalogId === catalogId && item.kind === kind)) return fail("该渠道型号已分配到此类节点。");
        const assignment: Assignment = { id: id("assignment"), catalogId, kind, groupId, name: source.name, rules: blankRules(kind), note: "" };
        set(state => ({ assignments: [...state.assignments, assignment] }));
        return { ok: true, id: assignment.id };
    },
    updateAssignment(assignmentId, patch) {
        const assignment = get().assignments.find(item => item.id === assignmentId);
        if (!assignment) return fail("模型配置不存在。");
        if (patch.groupId !== undefined && !get().groups.some(group => group.id === patch.groupId && group.kind === assignment.kind)) return fail("分组与节点类型不匹配。");
        set(state => ({ assignments: state.assignments.map(item => item.id === assignmentId ? { ...item, ...clone(patch) } : item) }));
        return { ok: true };
    },
    publishAssignment(assignmentId) {
        const assignment = get().assignments.find(item => item.id === assignmentId);
        if (!assignment) return fail("模型配置不存在。");
        const source = get().catalog.find(model => model.id === assignment.catalogId);
        if (!source?.available || !get().channels.some(channel => channel.id === source.channelId && channel.enabled)) return fail("渠道已停用或当前目录缺少该型号，请先核对。");
        const error = validateAssignment(assignment);
        if (error) return fail(error);
        const published = { version: (assignment.published?.version ?? 0) + 1, name: assignment.name.trim(), groupId: assignment.groupId,
            rules: parseModelPriceRules(assignment.rules, assignment.kind)!, note: assignment.note };
        set(state => ({ assignments: state.assignments.map(item => item.id === assignmentId ? { ...item, name: published.name, rules: clone(published.rules), published } : item) }));
        return { ok: true };
    },
    unpublishAssignment(assignmentId) {
        set(state => ({ assignments: state.assignments.map(item => item.id === assignmentId ? { ...item, published: undefined } : item) }));
    },
    reset() { set(createPreviewData()); },
}));

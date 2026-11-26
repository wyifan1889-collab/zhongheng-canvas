/** Local configuration preview only. No wallet, saved draft, publication or generation effects. */
export type MultiplierBasisRow = {
    id: string; label: string; unit: string; amount: string | null; quantityBase: 1 | 1000000;
    parameters?: Record<string, string>; quantityKind?: "integer" | "decimal";
};
export type MultiplierBasis = {
    model: string; currency: "USD" | "CNY"; source: string; version: string; context?: string;
    rows: MultiplierBasisRow[];
};
export type MultiplierPreviewInput = {
    basis: MultiplierBasis; costMultiplier: string; saleMultiplier: string;
    creditsPerCurrency: string; quantities: Record<string, string>;
};
export type MultiplierPreview = {
    rows: (MultiplierBasisRow & {
        costRate: string | null; saleRate: string | null;
        sampleBase: string | null; sampleCost: string | null; sampleSale: string | null;
    })[];
    issues: { field: string; message: string }[];
    sample: { baseTotal: string | null; costTotal: string | null; saleTotal: string | null };
    valid: boolean;
};

export function normalizeMultiplierAmount(value: unknown): string | null {
    if (typeof value !== "string" || value.length > 80 || !/^\d+(?:\.\d+)?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    const normalizedWhole = whole.replace(/^0+(?=\d)/, ""), normalizedFraction = fraction.replace(/0+$/, "");
    return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function parts(value: string) {
    const [whole, fraction = ""] = value.split(".");
    return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
function decimal(coefficient: bigint, scale: number): string {
    const digits = coefficient.toString().padStart(scale + 1, "0");
    const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
    return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
function multiply(...values: string[]): string {
    const items = values.map(parts);
    return decimal(items.reduce((product, item) => product * item.coefficient, BigInt(1)), items.reduce((scale, item) => scale + item.scale, 0));
}
function divideBase(value: string, base: 1 | 1000000): string {
    const item = parts(value);
    return decimal(item.coefficient, item.scale + (base === 1000000 ? 6 : 0));
}
function total(values: (string | null)[]): string | null {
    if (values.some(value => value === null)) return null;
    const items = (values as string[]).map(parts), scale = Math.max(0, ...items.map(item => item.scale));
    return decimal(items.reduce((sum, item) => sum + item.coefficient * BigInt(10) ** BigInt(scale - item.scale), BigInt(0)), scale);
}

export function previewMultiplierPricing(input: MultiplierPreviewInput): MultiplierPreview {
    const issues: MultiplierPreview["issues"] = [];
    const addIssue = (field: string, message: string) => issues.push({ field, message });
    const cost = input.costMultiplier === "" ? null : normalizeMultiplierAmount(input.costMultiplier);
    const sale = normalizeMultiplierAmount(input.saleMultiplier), credit = normalizeMultiplierAmount(input.creditsPerCurrency);
    if (input.costMultiplier !== "" && cost === null) addIssue("costMultiplier", "成本倍率须为非负十进制数；未知时留空。");
    if (sale === null || sale === "0") addIssue("saleMultiplier", "请填写大于 0 的售价倍率。");
    if (credit === null || credit === "0") addIssue("creditsPerCurrency", "请明确每基准货币单位对应的积分，且须大于 0。");
    const goodSale = sale !== null && sale !== "0" && credit !== null && credit !== "0";
    if (!input.basis.rows.length) addIssue("basis", "请提供基准价目。");
    if (!["USD", "CNY"].includes(input.basis.currency)) addIssue("basis.currency", "基准币种须明确为 USD 或 CNY。");
    const ids = new Set<string>();
    const rows = input.basis.rows.map(row => {
        const field = `row:${row.id}`, baseValid = row.quantityBase === 1 || row.quantityBase === 1000000;
        if (!row.id || ids.has(row.id)) addIssue(field, "计费项编号为空或重复。");
        ids.add(row.id);
        if (!baseValid) addIssue(field, "当前预览只支持每单位或每百万单位的价目。");
        const amount = normalizeMultiplierAmount(row.amount);
        if (amount === null) addIssue(field, "此项基准价格未知或无效，不能按 0 计算。");
        const costRate = amount !== null && cost !== null ? multiply(amount, cost) : null;
        const saleRate = amount !== null && goodSale ? multiply(amount, sale!, credit!) : null;
        let quantity = normalizeMultiplierAmount(input.quantities[row.id]);
        const integerQuantity = row.quantityKind === "integer" || (row.quantityKind === undefined && row.quantityBase === 1000000);
        if (quantity !== null && integerQuantity && quantity.includes(".")) {
            quantity = null;
            addIssue(`quantity:${row.id}`, "此项样例用量须为整数。");
        } else if (quantity === null) addIssue(`quantity:${row.id}`, "请明确此项样例用量；未使用请填 0。");
        const sample = (rate: string | null) => rate !== null && quantity !== null && baseValid ? divideBase(multiply(rate, quantity), row.quantityBase) : null;
        return { ...row, costRate, saleRate, sampleBase: sample(amount), sampleCost: sample(costRate), sampleSale: sample(saleRate) };
    });
    return { rows, issues, valid: issues.length === 0,
        sample: { baseTotal: rows.length ? total(rows.map(row => row.sampleBase)) : null,
            costTotal: rows.length ? total(rows.map(row => row.sampleCost)) : null,
            saleTotal: rows.length ? total(rows.map(row => row.sampleSale)) : null } };
}

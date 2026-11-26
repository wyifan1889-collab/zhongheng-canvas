import { useId, useRef, useState } from "react";
import { Input, Modal, type InputRef } from "antd";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export function CanvasCreateProjectDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
    const { t } = useTranslation();
    const inputId = useId();
    const inputRef = useRef<InputRef>(null);
    const submitted = useRef(false);
    const createProject = useCanvasStore((state) => state.createProject);
    const [title, setTitle] = useState(() => t("canvas.defaultTitle", { count: useCanvasStore.getState().projects.length + 1 }));
    const create = () => {
        if (!title.trim() || submitted.current) return;
        submitted.current = true;
        onCreated(createProject(title.trim()));
    };

    return (
        <Modal
            title={t("canvas.create")}
            open
            centered
            onCancel={onCancel}
            onOk={create}
            okText={t("canvas.createAndOpen")}
            cancelText={t("common.cancel")}
            okButtonProps={{ disabled: !title.trim() }}
            afterOpenChange={(open) => { if (open) inputRef.current?.focus({ cursor: "all" }); }}
            modalRender={(node) => <div data-canvas-shortcuts-ignore
                onKeyDown={(event) => { if (event.code === "Space") event.stopPropagation(); }}
                onKeyUp={(event) => { if (event.code === "Space") event.stopPropagation(); }}>{node}</div>}
        >
            <label htmlFor={inputId} className="mb-2 block">{t("canvas.name")}</label>
            <Input
                ref={inputRef}
                id={inputId}
                value={title}
                placeholder={t("canvas.namePlaceholder")}
                onChange={(event) => setTitle(event.target.value)}
                onPressEnter={(event) => { if (!event.nativeEvent.isComposing) create(); }}
            />
        </Modal>
    );
}

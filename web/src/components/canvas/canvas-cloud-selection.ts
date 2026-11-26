import { CanvasVersionSaveError, type createCanvasVersionSession, type CanvasVersionSelection } from "../../services/saas/canvas-version-save";

type Session = ReturnType<typeof createCanvasVersionSession>;

/** A directory confirmation owns a temporary session until the open dialog adopts it. */
export function createCanvasCloudSelection(isOpen: () => boolean, createSession: () => Session, adopt: (session: Session) => void) {
    let pending: Session | null = null;
    return {
        async confirm(selection: CanvasVersionSelection): Promise<void> {
            if (!isOpen()) throw new CanvasVersionSaveError("window_closed", "not-sent");
            if (pending) throw new CanvasVersionSaveError("busy", "not-sent");
            const candidate = createSession();
            pending = candidate;
            let adopted = false;
            try {
                await candidate.resumeFromCloudSelection(selection);
                if (pending !== candidate || !isOpen()) throw new CanvasVersionSaveError("window_closed", "unknown");
                if (candidate.getState().status !== "ready") throw new CanvasVersionSaveError("account_changed", "unknown");
                // No await between the final lifecycle check and page ownership transfer.
                adopt(candidate);
                adopted = true;
            } finally {
                if (pending === candidate) pending = null;
                if (!adopted) candidate.dispose();
            }
        },
        cancel() {
            pending?.dispose();
            pending = null;
        },
    };
}

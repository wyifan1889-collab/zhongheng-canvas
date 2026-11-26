import { createContext, useContext } from "react";

/** Explicit presentation opt-in. Shared/canvas/admin callers retain Ant. */
export const CreationUiContext = createContext(false);
export const useCreationUi = () => useContext(CreationUiContext);
// This predicate also controls creation return semantics. Keep it creation-only.
export const isCreationUiRoute = (pathname: string) => /^\/create\/?$/.test(pathname);
export { isOwnedUiRoute } from "./routes";

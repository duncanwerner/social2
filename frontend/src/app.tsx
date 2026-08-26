import { pageRoutes } from "virtual:file-routes";
import { createRouter } from "@solidjs/router";
import { fileRoutes } from "@solidjs/router/fs";
import { Loading } from "@solidjs/web";
import { AppNav } from "./components/AppNav";
import { refreshMe } from "./auth";

// File-based routing: route modules live in src/routes/. `virtual:file-routes`
// is emitted by the filesystem-routing Vite plugin; `fileRoutes()` turns it into
// @solidjs/router route definitions. All client-side — no SSR.
const Router = createRouter({ routes: fileRoutes(pageRoutes) });

export const App = () => {
  // Validate any stored session token once on load. Deferred to a microtask so
  // refreshMe's synchronous `token()` read happens outside App's render scope
  // (otherwise Solid 2 flags it as an untracked read).
  queueMicrotask(() => void refreshMe());
  return (
    <Router>
      {(props) => (
        <div class="app">
          <AppNav />
          {/* Route modules resolve asynchronously; a Loading boundary absorbs
              that so the root mount isn't deferred waiting on it. */}
          <Loading>{props.children}</Loading>
        </div>
      )}
    </Router>
  );
};

import { pageRoutes } from "virtual:file-routes";
import { createRouter } from "@solidjs/router";
import { fileRoutes } from "@solidjs/router/fs";
import { AppNav } from "./components/AppNav";
import { refreshMe } from "./auth";

// File-based routing: route modules live in src/routes/. `virtual:file-routes`
// is emitted by the filesystem-routing Vite plugin; `fileRoutes()` turns it into
// @solidjs/router route definitions. All client-side — no SSR.
const Router = createRouter({ routes: fileRoutes(pageRoutes) });

export const App = () => {
  // Validate any stored session token once on load.
  void refreshMe();
  return (
    <Router>
      {(props) => (
        <div class="app">
          <AppNav />
          {props.children}
        </div>
      )}
    </Router>
  );
};

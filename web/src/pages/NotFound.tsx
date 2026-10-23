import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import { Button, Panel } from "@/components/kit";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.warn("404: unknown route requested:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="mx-auto max-w-sm py-16">
      <Panel title="Error 404" bodyClassName="py-8">
        <div className="flex flex-col items-center gap-3">
          <span className="num text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            no route {location.pathname}
          </span>
          <Link to="/">
            <Button tone="solid">Return to grid</Button>
          </Link>
        </div>
      </Panel>
    </div>
  );
};

export default NotFound;

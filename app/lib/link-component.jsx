
import { forwardRef } from "react";
import { Link as RemixLink } from "react-router";

export const AppLink = forwardRef(function AppLink(
  { children, url = "", external, ref: _r, ...rest }, ref
) {
  if (external || /^https?:\/\//.test(url)) {
    return <a {...rest} href={url} target="_blank" rel="noopener noreferrer" ref={ref}>{children}</a>;
  }
  return <RemixLink to={url} {...rest} ref={ref}>{children}</RemixLink>;
});

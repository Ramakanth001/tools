import React, { createContext, useContext } from "react";

type NavigationValue = {
  homePath: string;
  navigate: (path: string) => void;
};

export const VoiceCloneNavigationContext = createContext<NavigationValue>({
  homePath: "/tools/self-voice-clone",
  navigate: () => {},
});

export function VoiceCloneLink({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const navigation = useContext(VoiceCloneNavigationContext);
  const suffix = href === "/" ? "" : `/${href.replace(/^\/+/, "")}`;
  const destination = `${navigation.homePath.replace(/\/+$/, "")}${suffix}`;

  return (
    <a
      {...props}
      href={destination}
      onClick={(event) => {
        props.onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigation.navigate(destination);
      }}
    >
      {children}
    </a>
  );
}

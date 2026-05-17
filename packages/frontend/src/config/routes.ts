/**
 * Route Configuration
 * Centralized route definitions with metadata
 */

/**
 * Route metadata interface
 */
export interface RouteConfig {
  /**
   * Route path
   */
  path: string;

  /**
   * Translation key for page title
   * If null, title is determined dynamically (e.g., Agent name for chat page)
   */
  titleKey: string | null;

  /**
   * Whether this route requires authentication
   */
  requiresAuth?: boolean;
}

/**
 * Application route configurations
 */
export const routes = {
  home: {
    path: '/',
    titleKey: 'navigation.home',
    requiresAuth: true,
  },
  chat: {
    path: '/chat',
    titleKey: null, // Dynamically uses selected Agent name
    requiresAuth: true,
  },
  chatWithSession: {
    path: '/chat/:sessionId',
    titleKey: null, // Dynamically uses selected Agent name
    requiresAuth: true,
  },
  searchChat: {
    path: '/chat/search',
    titleKey: 'navigation.searchChat',
    requiresAuth: true,
  },
  agentDirectory: {
    path: '/agents',
    titleKey: 'navigation.searchAgents',
    requiresAuth: true,
  },
  tools: {
    path: '/tools',
    titleKey: 'navigation.searchTools',
    requiresAuth: true,
  },
  events: {
    path: '/events',
    titleKey: 'navigation.events',
    requiresAuth: true,
  },
  settings: {
    path: '/settings',
    titleKey: 'navigation.settings',
    requiresAuth: true,
  },
} as const;

/**
 * Get route config by path
 * @param path - Route path to lookup
 * @returns Route config or undefined if not found
 */
export function getRouteConfig(path: string): RouteConfig | undefined {
  // Remove trailing slash for comparison
  const normalizedPath = path.replace(/\/$/, '') || '/';

  // Check for exact match first
  const exactMatch = Object.values(routes).find((route) => route.path === normalizedPath);
  if (exactMatch) return exactMatch;

  // Check for parameterized routes (e.g., /chat/:sessionId)
  if (normalizedPath.startsWith('/chat/')) {
    return routes.chatWithSession;
  }

  return undefined;
}

/**
 * Get page title key for a given path
 * @param path - Route path
 * @returns Translation key or null if dynamic
 */
export function getPageTitleKey(path: string): string | null {
  const config = getRouteConfig(path);
  return config?.titleKey ?? null;
}

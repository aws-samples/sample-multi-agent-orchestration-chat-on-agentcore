import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import mermaid from 'mermaid';
import { useThemeStore } from '../stores/themeStore';
import { logger } from '../utils/logger';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
}

// Function to generate unique ID
const generateUniqueId = () => {
  return `mermaid-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
};

const MermaidDiagramComponent: React.FC<MermaidDiagramProps> = ({ chart, className = '' }) => {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [isValidSyntax, setIsValidSyntax] = useState<boolean | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const currentChartRef = useRef<string>('');
  const currentThemeRef = useRef<string>('');
  const mountedRef = useRef(true);

  useEffect(() => {
    const mermaidTheme = resolvedTheme === 'dark' ? 'dark' : 'default';
    mermaid.initialize({
      startOnLoad: false,
      theme: mermaidTheme,
      securityLevel: 'loose',
      fontFamily: 'inherit',
      fontSize: 14,
      flowchart: {
        htmlLabels: true,
        curve: 'basis',
      },
      sequence: {
        diagramMarginX: 50,
        diagramMarginY: 10,
        actorMargin: 50,
        width: 150,
        height: 65,
        boxMargin: 10,
        boxTextMargin: 5,
        noteMargin: 10,
        messageMargin: 35,
      },
      gantt: {
        titleTopMargin: 25,
        barHeight: 20,
        fontSize: 12,
        gridLineStartPadding: 35,
      },
    });
  }, [resolvedTheme]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    const renderChart = async () => {
      // Stop processing if component unmounted
      if (!mountedRef.current || !chart.trim()) {
        if (mountedRef.current) {
          setIsValidSyntax(null);
          setSvgContent(null);
        }
        return;
      }

      // Skip if same chart and same theme (prevent infinite rendering)
      if (currentChartRef.current === chart.trim() && currentThemeRef.current === resolvedTheme) {
        return;
      }

      currentChartRef.current = chart.trim();
      currentThemeRef.current = resolvedTheme;
      setIsRendering(true);

      try {
        // First check syntax
        await mermaid.parse(chart);

        // Check if component still mounted
        if (!mountedRef.current) {
          return;
        }

        setIsValidSyntax(true);

        // Generate unique ID
        const uniqueId = generateUniqueId();

        // Render with Mermaid (no DOM manipulation, only get SVG)
        const { svg } = await mermaid.render(uniqueId, chart);

        // Check if still mounted after rendering
        if (!mountedRef.current) {
          return;
        }

        // Set SVG to state (React manages DOM)
        setSvgContent(svg);
      } catch (error) {
        // If error occurs
        logger.warn('Mermaid rendering error:', error);

        if (mountedRef.current) {
          setIsValidSyntax(false);
          setSvgContent(null);
        }
      } finally {
        if (mountedRef.current) {
          setIsRendering(false);
        }
      }
    };

    // Debounce: Execute rendering after 100ms wait
    debounceTimerRef.current = window.setTimeout(renderChart, 100);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [chart, resolvedTheme]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      className={`mermaid-diagram overflow-x-auto my-4 ${className}`}
      style={{
        // Adjust Mermaid SVG style
        fontSize: 'inherit',
        fontFamily: 'inherit',
        minHeight: isValidSyntax === null ? '20px' : undefined,
      }}
    >
      {/* Loading */}
      {isRendering && (
        <div className="text-action-primary text-sm italic py-2">
          {t('common.renderingDiagram')}
        </div>
      )}

      {/* Syntax error */}
      {isValidSyntax === false && chart.trim() && !isRendering && (
        <div className="text-fg-disabled text-sm italic py-2">{t('common.diagramLoading')}</div>
      )}

      {/* Display SVG content (under React management) */}
      {svgContent && !isRendering && (
        <div className="mermaid-svg-container" dangerouslySetInnerHTML={{ __html: svgContent }} />
      )}
    </div>
  );
};

// Wrap with React.memo to prevent re-renders unless props change
export const MermaidDiagram = React.memo(MermaidDiagramComponent);

/**
 * Home Page Component
 * Application introduction and main navigation
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Coffee, MessageCircle } from 'lucide-react';

export function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <>
      <main className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className="max-w-2xl space-y-8">
          {/* Main icon */}
          <div className="relative">
            <div className="absolute inset-0 bg-amber-200 rounded-full blur-3xl opacity-30 scale-150"></div>
            <Coffee className="w-24 h-24 text-amber-600 mx-auto" />
          </div>

          {/* Title and description */}
          <div className="space-y-4">
            <p className="text-md text-amber-600 leading-relaxed max-w-lg mx-auto">
              {t('home.description')}
              <br />
              {t('home.descriptionLine2')}
            </p>
          </div>

          {/* CTA buttons */}
          <div className="pt-8">
            <button
              onClick={() => navigate('/chat')}
              className="group px-12 py-4 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-full text-lg font-semibold transition-all duration-300 shadow-md"
            >
              <span className="flex items-center gap-2">
                {t('home.getStarted')}
                <MessageCircle className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </span>
            </button>
          </div>
        </div>
      </main>
    </>
  );
}

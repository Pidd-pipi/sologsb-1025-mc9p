import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideZoneChangeDetection } from '@angular/core';
import { NbThemeModule, NbToastrModule } from '@nebular/theme';
import { AppComponent } from './app/app.component';

const nebularProviders = [
  ...(NbThemeModule.forRoot({ name: 'default' }).providers ?? []),
  ...(NbToastrModule.forRoot().providers ?? [])
];

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideAnimations(),
    ...nebularProviders
  ]
}).catch((error) => console.error(error));

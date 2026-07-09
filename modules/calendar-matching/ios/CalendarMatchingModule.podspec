Pod::Spec.new do |s|
  s.name           = 'CalendarMatchingModule'
  s.version        = '1.0.0'
  s.summary        = 'Native EventKit fetching and calendar-to-visit matching for Palate'
  s.description    = 'Fetches minimal EventKit records and matches them to restaurant visits on an owned native queue.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'EventKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end

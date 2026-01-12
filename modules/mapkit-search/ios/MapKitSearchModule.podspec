Pod::Spec.new do |s|
  s.name           = 'MapKitSearchModule'
  s.version        = '1.0.0'
  s.summary        = 'Native MapKit search for nearby restaurants'
  s.description    = 'Uses MapKit MKLocalSearch to find nearby restaurants and points of interest'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'MapKit', 'CoreLocation'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

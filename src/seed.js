export function createInitialState() {
  return {
    version: 0,
    profile: { displayName: 'ผู้ใช้งาน', pictureUrl: '' },
    settings: {
      onboardingComplete: false,
      salary: 0,
      licenseAllowance: 0,
      otRate: 0,
      standardHours: 176,
      cycleStartDay: 25,
      uncertaintyBuffer: 500,
      confirmedCycle: null,
      notificationsEnabled: true
    },
    shiftTypes: [
      { id: 'morning', name: 'เวรเช้า', startTime: '08:00', endTime: '16:00', premium: 0, color: '#F59E0B' },
      { id: 'evening', name: 'เวรบ่าย', startTime: '16:00', endTime: '00:00', premium: 200, color: '#8B5CF6' },
      { id: 'night', name: 'เวรดึก', startTime: '00:00', endTime: '08:00', premium: 300, color: '#2563EB' }
    ],
    shifts: [],
    specialOtItems: [],
    dayOffs: [],
    financialItems: [],
    reminders: [
      { id: 'one-day', offsetMinutes: 1440, enabled: true },
      { id: 'one-hour', offsetMinutes: 60, enabled: true }
    ]
  };
}

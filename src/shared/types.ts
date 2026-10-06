import type { AdditionalFact } from '../autofill/contracts.ts';
// 用户资料数据模型
export interface UserProfile extends SupplementalProfile {
  additionalFacts?: AdditionalFact[];
  personal: PersonalInfo;
  education: EducationInfo[];
  experience: ExperienceInfo[];
  projects: ProjectInfo[];
  customInformation: CustomInformation[];
  skills: string[];
  certifications: CertificationInfo[];
  resume?: ResumeInfo;
  resumes?: ResumeVariant[];
}

export interface CustomInformation {
  id: string;
  name: string;
  content: string;
}

export interface PersonalInfo {
  nationality?: string;
  employmentStatus?: string;
  desiredPosition?: string;
  expectedSalary?: string;
  availability?: string;
  githubUrl?: string;
  linkedinUrl?: string;
  age?: string;
  portfolioUrl?: string;
  preferredCities?: string;
  languageSkills?: string;
  additionalFields?: AdditionalFact[];
  name: string;
  gender: string;
  birthDate: string;
  phone: string;
  email: string;
  wechat?: string;
  idCard?: string;
  politicalStatus?: string;
  ethnicity?: string;
  hometown?: string;
  currentAddress?: string;
  selfEvaluation?: string;
}

export interface EducationInfo {
  id: string;
  school: string;
  college?: string;
  educationType?: string;
  major: string;
  /** 专业所属大类/一级学科，例如“能源动力类”“动力工程及工程热物理”。 */
  majorCategory?: string;
  /** 学历层次，例如“本科”“硕士研究生”。旧数据仍保存在 degree 中。 */
  degree: string;
  /** 学位，例如“工学学士”“工程硕士”；与学历层次分开保存。 */
  academicDegree?: string;
  startDate: string;
  endDate: string;
  gpa?: string;
  ranking?: string;
}

export interface ExperienceInfo {
  id: string;
  company: string;
  position: string;
  startDate: string;
  endDate: string;
  description: string;
  achievements?: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  role: string;
  startDate: string;
  endDate: string;
  description: string;
  achievements: string;
  technologies?: string;
}

export interface CertificationInfo {
  id: string;
  name: string;
  issuer: string;
  date: string;
  credentialId?: string;
  expiryDate?: string;
  description?: string;
}

export interface AwardInfo { id: string; name: string; issuer?: string; date?: string; level?: string; ranking?: string; description?: string }
export interface PublicationInfo { id: string; title: string; authors?: string; venue?: string; date?: string; status?: string; doi?: string; url?: string; description?: string }
export interface LanguageInfo { id: string; language: string; proficiency?: string; test?: string; score?: string; date?: string; description?: string }
export interface PatentInfo { id: string; name: string; inventors?: string; patentNumber?: string; type?: string; status?: string; date?: string; description?: string }
export interface ActivityInfo { id: string; organization: string; role?: string; startDate?: string; endDate?: string; description?: string; achievements?: string }
export interface AdditionalInfo { id: string; name: string; content: string }
/** Optional for compatibility with profiles and backups created before these sections existed. */
export interface SupplementalProfile {
  awards?: AwardInfo[];
  publications?: PublicationInfo[];
  languages?: LanguageInfo[];
  patents?: PatentInfo[];
  activities?: ActivityInfo[];
  additionalInfo?: AdditionalInfo[];
}

export interface ResumeInfo {
  fileName: string;
  fileData: string; // Base64编码
  fileType: string;
  parsedText?: string;
  uploadDate: string;
}

export interface ResumeProfileSnapshot extends SupplementalProfile {
  personal: Partial<PersonalInfo>;
  education: EducationInfo[];
  experience: ExperienceInfo[];
  projects: ProjectInfo[];
  skills: string[];
  certifications?: CertificationInfo[];
}

export interface ResumeVariant extends ResumeInfo {
  id: string;
  category: string;
  /** 该文件独立解析出的资料，切换简历时用于填充和悬浮窗展示。 */
  parsedProfile?: ResumeProfileSnapshot;
}

export type SettingsData = Record<string, unknown>;

export interface BackupData {
  userProfile: UserProfile | null;
  settings: SettingsData | null;
  /** Opaque legacy backup data; the application-tracking feature has been removed. */
  applicationRecords?: Record<string, unknown>[] | null;
}

export interface BackupDocumentV1 {
  schemaVersion: 1;
  exportedAt: string;
  source: {
    extensionVersion: string;
  };
  data: BackupData;
}

export type BackupDocument = BackupDocumentV1;

export type BackupErrorCode =
  | 'FILE_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_ROOT'
  | 'MISSING_SCHEMA_VERSION'
  | 'INVALID_SCHEMA_VERSION'
  | 'UNSUPPORTED_FUTURE_VERSION'
  | 'UNSUPPORTED_OLD_VERSION'
  | 'INVALID_EXPORTED_AT'
  | 'INVALID_SOURCE'
  | 'INVALID_DATA'
  | 'INVALID_USER_PROFILE'
  | 'INVALID_SETTINGS';

export interface BackupParseError {
  code: BackupErrorCode;
  message: string;
}

export type BackupParseResult =
  | { success: true; document: BackupDocument }
  | { success: false; error: BackupParseError };

export interface BackupSummary {
  schemaVersion: number;
  exportedAt: string;
  extensionVersion: string;
  hasUserProfile: boolean;
  hasResumeFile: boolean;
}

export type FocusedFieldFailureReason =
  | 'NO_ACTIVE_TAB'
  | 'NO_CONTENT_SCRIPT'
  | 'NO_FOCUSED_FIELD'
  | 'FIELD_DETACHED'
  | 'FIELD_NOT_WRITABLE'
  | 'FILL_IN_PROGRESS'
  | 'VALUE_REJECTED'
  | 'RESTRICTED_PAGE';

export interface FocusedFieldWriteResult {
  written: boolean;
  reason?: FocusedFieldFailureReason;
}

// 消息类型定义
export type Message =
  | { type: 'GET_FILL_SESSION_RESULT'; payload?: { sessionId?: string } }
  | { type: 'FILL_PAGE_BRIDGE'; payload: Record<string, any> }
  | { type: 'FILL_LOCAL_BRIDGE'; payload: Record<string, any> }
  | { type: 'BEGIN_FILL_SESSION'; payload: { sessionId: string; sourceId: string; origin: string; attachmentId?: string | null } }
  | { type: 'END_FILL_SESSION'; payload: { sessionId: string } }
  | { type: 'SAVE_PERSONAL_FIELD'; payload: { label: string; value: string; valueType?: 'text' | 'date'; expectedValue?: string } }
  | { type: 'SAVE_ADDITIONAL_FACT'; payload: { fact: AdditionalFact; profileVersion: string } }
  | { type: 'START_FILL_SESSION'; payload: { sourceId: string; attachmentId?: string | null; region?: boolean } }
  | { type: 'OPEN_PROFILE_SETTINGS'; payload?: null }
  | { type: 'GET_USER_PROFILE'; payload?: null }
  | { type: 'SAVE_USER_PROFILE'; payload: UserProfile }
  | { type: 'PARSE_RESUME'; payload: { file: string; fileType: string; fileName: string; category?: string; rawText?: string; requestId?: string } }
  | { type: 'CANCEL_RESUME_IMPORT'; payload: { requestId: string } }
  | { type: 'FILL_FORM'; payload?: { reusePreview?: boolean; resumeId?: string | null } | null }
  | { type: 'UNDO_LAST_FILL'; payload?: null }
  | { type: 'PING_CONTENT'; payload?: null }
  | { type: 'OPEN_INFO_OVERLAY'; payload?: { resumeId?: string | null } | null }
  | { type: 'SET_INFO_OVERLAY_RESUME'; payload: { resumeId?: string | null } }
  | { type: 'ENSURE_CONTENT_SCRIPT'; payload: { tabId: number } }
  | { type: 'DETECT_FIELDS'; payload?: null }
  | { type: 'WRITE_FOCUSED_FIELD_FROM_PAGE'; payload: { value: string } }
  | { type: 'APPLY_FOCUSED_FIELD'; payload: { value: string } }
  | { type: 'EXPORT_BACKUP'; payload?: null }
  | { type: 'PREVIEW_BACKUP_IMPORT'; payload: { json: string } }
  | { type: 'IMPORT_BACKUP'; payload: { json: string } };

export interface MessageResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// 表单字段检测结果
export interface DetectedField {
  element: HTMLElement;
  /** Resolved accessible label, shared with record binding. */
  label?: string;
  fieldType: string;
  confidence: number;
  value?: string;
}

export const FieldType = {
  NAME: 'name',
  GENDER: 'gender',
  BIRTH_DATE: 'birthDate',
  PHONE: 'phone',
  EMAIL: 'email',
  WECHAT: 'wechat',
  ID_CARD: 'idCard',
  POLITICAL_STATUS: 'politicalStatus',
  ETHNICITY: 'ethnicity',
  HOMETOWN: 'hometown',
  CURRENT_ADDRESS: 'currentAddress',
  SCHOOL: 'school',
  COLLEGE: 'college',
  EDUCATION_TYPE: 'educationType',
  MAJOR: 'major',
  MAJOR_CATEGORY: 'majorCategory',
  DEGREE: 'degree',
  ACADEMIC_DEGREE: 'academicDegree',
  GPA: 'gpa',
  SELF_EVALUATION: 'selfEvaluation',
  EDUCATION_START_DATE: 'educationStartDate',
  GRADUATION_DATE: 'graduationDate',
  COMPANY: 'company',
  POSITION: 'position',
  START_DATE: 'startDate',
  END_DATE: 'endDate',
  DESCRIPTION: 'description',
  PROJECT_NAME: 'projectName',
  PROJECT_ROLE: 'projectRole',
  PROJECT_START_DATE: 'projectStartDate',
  PROJECT_END_DATE: 'projectEndDate',
  PROJECT_DESCRIPTION: 'projectDescription',
  PROJECT_ACHIEVEMENTS: 'projectAchievements',
  PROJECT_TECHNOLOGIES: 'projectTechnologies',
  SKILLS: 'skills',
  RESUME_FILE: 'resumeFile',
  UNKNOWN: 'unknown'
} as const;
export type FieldType = typeof FieldType[keyof typeof FieldType];

export interface ParsedResumeData {
  /** Ambiguous research entries need an explicit review choice before becoming profile facts. */
  publicationCandidates?: Partial<PublicationInfo>[];
  parsingWarnings?: string[];
  personal?: Partial<PersonalInfo>;
  education?: Partial<EducationInfo>[];
  experience?: Partial<ExperienceInfo>[];
  projects?: Partial<ProjectInfo>[];
  skills?: string[];
  certifications?: Partial<CertificationInfo>[];
  awards?: Partial<AwardInfo>[];
  publications?: Partial<PublicationInfo>[];
  languages?: Partial<LanguageInfo>[];
  patents?: Partial<PatentInfo>[];
  activities?: Partial<ActivityInfo>[];
  additionalInfo?: Partial<AdditionalInfo>[];
  rawText: string;
}

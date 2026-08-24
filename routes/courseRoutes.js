const express = require('express');
const router = express.Router();
const { createCourse, getAllCourses, getContentVault, getCourse, updateCourse, deleteCourse, addLesson, addModule, deleteLesson, deleteModule, addResource, deleteResource, updateModule, updateLesson, updateResource, reorderModules, reorderLessons, moveLesson, reorderCourses} = require('../controllers/courseController');
const { protect, admin } = require('../middleware/authMiddleware');
const { singleImage } = require('../config/upload');

router.route('/')
    .get(protect, getAllCourses)
    .post(protect, admin, singleImage('thumbnail'), createCourse);

// Baúl de contenido. DEBE ir antes de '/:id', si no Express interpreta
// "vault" como un id de curso y devuelve 404.
router.get('/vault', protect, getContentVault);

// Reordenar el listado de cursos. También antes de '/:id' por el mismo motivo.
router.put('/reorder', protect, admin, reorderCourses);

// Rutas específicas por ID (GET, PUT, DELETE)
router.route('/:id')
    .get(protect, getCourse)
    .put(protect, admin, singleImage('thumbnail'), updateCourse)
    .delete(protect, admin, deleteCourse);

router.route('/:id/modules')
    .post(protect, admin, addModule);

// Reordenar. DEBEN ir antes de las rutas con :moduleId / :lessonId, si no
// Express toma "reorder" como si fuera un id y responde 404.
router.put('/:id/modules/reorder', protect, admin, reorderModules);
router.put('/:id/modules/:moduleId/lessons/reorder', protect, admin, reorderLessons);
router.put('/:id/modules/:moduleId/lessons/:lessonId/move', protect, admin, moveLesson);

// Rutas para Lecciones (requiere ID del curso y ID del módulo)
router.route('/:id/modules/:moduleId/lessons')
    .post(protect, admin, addLesson);

router.route('/:id/modules/:moduleId')
    .put(protect, admin, updateModule)
    .delete(protect, admin, deleteModule);

// Modifica esta sección para incluir DELETE en lecciones
router.route('/:id/modules/:moduleId/lessons/:lessonId')
    .put(protect, admin, updateLesson)
    .delete(protect, admin, deleteLesson);

router.route('/:id/modules/:moduleId/lessons/:lessonId/resources')
    .post(protect, admin, addResource);

router.route('/:id/modules/:moduleId/lessons/:lessonId/resources/:resourceId')
    .put(protect, admin, updateResource)
    .delete(protect, admin, deleteResource);

module.exports = router;
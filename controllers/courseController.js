const Course = require('../models/Course');
const cloudinary = require('../config/cloudinary');
const fs = require('fs');

// @desc    Crear un nuevo curso
// @route   POST /api/courses
// @access  Privado (Admin)
const createCourse = async (req, res) => {
    try {
        const { title, description } = req.body;

        let thumbnail = "https://via.placeholder.com/300"; // Imagen por defecto

        // Si suben imagen, la mandamos a Cloudinary
        if (req.file) {
            const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_courses",
                width: 800,
                crop: "scale"
            });
            thumbnail = result.secure_url;
            fs.unlinkSync(req.file.path); // Limpiar servidor
        }

        const course = await Course.create({
            title,
            description,
            thumbnail,
            instructor: req.user._id // El admin que lo crea es el instructor
        });

        res.status(201).json(course);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear el curso' });
    }
};

// @desc    Obtener todos los cursos
// @route   GET /api/courses
// @access  Público (o Privado, según prefieras)
const getAllCourses = async (req, res) => {
    try {
        // .populate trae los datos del instructor en vez de solo su ID
        const courses = await Course.find().populate('instructor', 'username avatar');
        res.json(courses);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener cursos' });
    }
};

// @desc    Obtener un solo curso
// @route   GET /api/courses/:id
const getCourse = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id)
            .populate('instructor', 'username')
            .populate('modules'); // Traeremos los módulos también
        
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });
        
        res.json(course);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener curso' });
    }
};

// @desc    Actualizar curso (Título, descripción, imagen)
// @route   PUT /api/courses/:id
const updateCourse = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // Actualizar campos básicos
        course.title = req.body.title || course.title;
        course.description = req.body.description || course.description;

        // Si hay nueva imagen
        if (req.file) {
             const result = await cloudinary.uploader.upload(req.file.path, {
                folder: "lms_courses",
                width: 800,
                crop: "scale"
            });
            course.thumbnail = result.secure_url;
            fs.unlinkSync(req.file.path);
        }

        const updatedCourse = await course.save();
        res.json(updatedCourse);
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar curso' });
    }
};

// @desc    Eliminar curso
// @route   DELETE /api/courses/:id
const deleteCourse = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // Usamos deleteOne() porque remove() está obsoleto en Mongoose moderno
        await course.deleteOne(); 
        
        res.json({ message: 'Curso eliminado' });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'Error al eliminar curso' });
    }
};

const addModule = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const { title } = req.body;
        
        // Mongoose crea automáticamente un _id para este subdocumento
        course.modules.push({ title, lessons: [] });
        
        await course.save();
        res.json(course); // Devolvemos el curso completo actualizado
    } catch (error) {
        res.status(500).json({ message: 'Error al agregar módulo' });
    }
};

// @desc    Agregar una Clase (Lección) a un Módulo
// @route   POST /api/courses/:id/modules/:moduleId/lessons
const addLesson = async (req, res) => {
    try {
        const { title, videoUrl, description } = req.body;
        const course = await Course.findById(req.params.id);
        
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // Buscar el módulo específico dentro del array
        const module = course.modules.id(req.params.moduleId);
        
        if (!module) return res.status(404).json({ message: 'Módulo no encontrado' });

        // Agregar la lección
        module.lessons.push({ title, videoUrl, description });

        await course.save();
        res.json(course);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: 'Error al agregar lección' });
    }
};
// ---------------------------------------------------
// NUEVAS FUNCIONES PARA BORRADO ESPECÍFICO (FASE 6)
// ---------------------------------------------------

// @desc    Eliminar un Módulo específico
// @route   DELETE /api/courses/:id/modules/:moduleId
const deleteModule = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // Mongoose Array.pull: Elimina el subdocumento con ese ID
        course.modules.pull(req.params.moduleId);

        await course.save();
        res.json(course); // Devolvemos el curso actualizado
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar módulo' });
    }
};

// @desc    Eliminar una Lección específica
// @route   DELETE /api/courses/:id/modules/:moduleId/lessons/:lessonId
const deleteLesson = async (req, res) => {
    try {
        const course = await Course.findById(req.params.id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        // 1. Encontrar el módulo
        const module = course.modules.id(req.params.moduleId);
        if (!module) return res.status(404).json({ message: 'Módulo no encontrado' });

        // 2. Eliminar la lección del array de lecciones de ese módulo
        module.lessons.pull(req.params.lessonId);

        await course.save();
        res.json(course);
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar lección' });
    }
};

// ACTUALIZA TU EXPORT AL FINAL DEL ARCHIVO ASÍ:
// ---------------------------------------------------
// GESTIÓN DE RECURSOS (Archivos/Links por clase)
// ---------------------------------------------------

// @desc    Agregar un recurso a una lección
// @route   POST /api/courses/:id/modules/:moduleId/lessons/:lessonId/resources
const addResource = async (req, res) => {
    const { id, moduleId, lessonId } = req.params;
    const { label, url, type } = req.body; // type puede ser 'file', 'link', 'video', etc.

    try {
        const course = await Course.findById(id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const module = course.modules.id(moduleId);
        if (!module) return res.status(404).json({ message: 'Módulo no encontrado' });

        const lesson = module.lessons.id(lessonId);
        if (!lesson) return res.status(404).json({ message: 'Lección no encontrada' });

        // Push al array de recursos
        lesson.resources.push({ label, url, type: type || 'file' });

        await course.save();
        res.json(course);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al agregar recurso' });
    }
};

// @desc    Eliminar un recurso de una lección
// @route   DELETE /api/courses/:id/modules/:moduleId/lessons/:lessonId/resources/:resourceId
const deleteResource = async (req, res) => {
    const { id, moduleId, lessonId, resourceId } = req.params;

    try {
        const course = await Course.findById(id);
        if (!course) return res.status(404).json({ message: 'Curso no encontrado' });

        const module = course.modules.id(moduleId);
        const lesson = module?.lessons.id(lessonId);
        
        if (!lesson) return res.status(404).json({ message: 'Lección no encontrada' });

        // Eliminar recurso del array
        lesson.resources.pull(resourceId);

        await course.save();
        res.json(course);
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar recurso' });
    }
};

// ¡ACTUALIZA EL EXPORT!
module.exports = { 
    createCourse, 
    getAllCourses, 
    getCourse, 
    updateCourse, 
    deleteCourse,
    addModule,   // Nuevo
    addLesson,   // Nuevo
    deleteModule,
    deleteLesson,
    deleteResource,
    addResource
};